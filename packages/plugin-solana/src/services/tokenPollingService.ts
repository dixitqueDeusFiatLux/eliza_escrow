import { Connection, PublicKey, TransactionInstruction, Transaction, sendAndConfirmTransaction, Keypair, SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createTransferCheckedInstruction, MINT_SIZE, getMinimumBalanceForRentExemptMint, createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getMint } from "@solana/spl-token";
import fs from 'fs';
import path from 'path';
import BigNumber from 'bignumber.js';
import { randomBytes } from 'crypto';
import BN from "bn.js";
import { elizaLogger } from "@ai16z/eliza";
import { watch } from 'fs';
import { writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';

export interface PollingTask {
  associatedTokenAccount: string;
  mintAddress: string;
  expectedAmount: string;
  threshold: number;
  status: 'pending' | 'completed' | 'failed' | 'request_cancel' | 'cancelled';
  lastCheckedAmount?: string;
  lastCheckedTime?: number;
  completedTime?: number;
  error?: string;
  escrow: string;
  initializer: string;
  taker: string;
  mintA: string;
  initializerAtaA: string;
  initializerAtaB: string;
  takerAtaA: string;
  takerAtaB: string;
  vaultA: string;
  initializerSecretKey: number[];
  tweet?: {
    id: string;
    text: string;
    username: string;
    timestamp: number;
    conversationId: string;
  };
  thread?: Array<{
    id: string;
    text: string;
    username: string;
    timestamp: number;
  }>;
  message?: {
    content: { text: string };
    agentId: string;
    userId: string;
    roomId: string;
  };
  tradeDetails?: {
    sentAmount: number;
    sentSymbol: string;
    receivedAmount: number;
    receivedSymbol: string;
  };
}

interface PollingState {
  tasks: PollingTask[];
  lastPollTime: number;
}

const PROGRAM_ID = new PublicKey("7xPuVJEKsK3Y7fTbDVhVgzBmHrzfATQSerpsyKe3aMma");
const PRIORITY_FEE = 1000000;

async function executeExchange(
  connection: Connection,
  accounts: {
    initializer: PublicKey,
    taker: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    initializerAtaA: PublicKey,
    initializerAtaB: PublicKey,
    takerAtaA: PublicKey,
    takerAtaB: PublicKey,
    escrow: PublicKey,
    vaultA: PublicKey,
    vaultB: PublicKey,
  },
  initializerKeypair: Keypair
): Promise<string> {
  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_FEE
  });

  const exchangeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.initializer, isSigner: true, isWritable: true },
      { pubkey: accounts.taker, isSigner: false, isWritable: false },
      { pubkey: accounts.mintA, isSigner: false, isWritable: false },
      { pubkey: accounts.mintB, isSigner: false, isWritable: false },
      { pubkey: accounts.initializerAtaA, isSigner: false, isWritable: true },
      { pubkey: accounts.initializerAtaB, isSigner: false, isWritable: true },
      { pubkey: accounts.takerAtaA, isSigner: false, isWritable: true },
      { pubkey: accounts.takerAtaB, isSigner: false, isWritable: true },
      { pubkey: accounts.escrow, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultA, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultB, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([47, 3, 27, 97, 215, 236, 219, 144]) // exchange discriminator
  });

  const transaction = new Transaction()
    .add(priorityFeeIx)
    .add(exchangeIx);

  const latestBlockhash = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  transaction.feePayer = initializerKeypair.publicKey;
  
  return await sendAndConfirmTransaction(
    connection,
    transaction,
    [initializerKeypair],
    {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 5,
      preflightCommitment: 'processed'
    }
  );
}

async function executeInitialize(
  connection: Connection,
  accounts: {
    initializer: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    initializerAtaA: PublicKey,
    escrow: PublicKey,
    vaultA: PublicKey,
    vaultB: PublicKey,
  },
  initializerKeypair: Keypair,
  seed: number[],
  initializerAmount: number,
  takerAmount: number,
  taker: PublicKey
): Promise<Transaction> {
  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: accounts.initializer, isSigner: true, isWritable: true },
      { pubkey: accounts.mintA, isSigner: false, isWritable: false },
      { pubkey: accounts.mintB, isSigner: false, isWritable: false },
      { pubkey: accounts.initializerAtaA, isSigner: false, isWritable: true },
      { pubkey: accounts.escrow, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultA, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultB, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]), // initialize discriminator
      Buffer.from(seed),
      new BN(initializerAmount).toArrayLike(Buffer, 'le', 8),
      new BN(takerAmount).toArrayLike(Buffer, 'le', 8),
      taker.toBuffer()
    ])
  });

  const tx = new Transaction().add(instruction);
  
  return tx;
}

async function executeTransfer(
  connection: Connection,
  fromAccount: PublicKey,
  mint: PublicKey,
  toAccount: PublicKey,
  owner: Keypair,
  amount: number,
  decimals: number = 6
): Promise<string> {
  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_FEE
  });

  const transferIx = createTransferCheckedInstruction(
    fromAccount,
    mint,
    toAccount,
    owner.publicKey,
    amount,
    decimals
  );

  const transaction = new Transaction()
    .add(priorityFeeIx) 
    .add(transferIx);

  const latestBlockhash = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  transaction.feePayer = owner.publicKey;
  
  return await sendAndConfirmTransaction(
    connection,
    transaction,
    [owner],
    {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 5,
      preflightCommitment: 'processed'
    }
  );
}

async function executeCancel(
  connection: Connection,
  accounts: {
    initializer: PublicKey,
    taker: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    initializerAtaA: PublicKey,
    takerAtaB: PublicKey,
    escrow: PublicKey,
    vaultA: PublicKey,
    vaultB: PublicKey,
  },
  initializerKeypair: Keypair
): Promise<string> {
  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: PRIORITY_FEE
  });

  const cancelIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: initializerKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: accounts.initializer, isSigner: false, isWritable: true },
      { pubkey: accounts.taker, isSigner: false, isWritable: false },
      { pubkey: accounts.mintA, isSigner: false, isWritable: false },
      { pubkey: accounts.mintB, isSigner: false, isWritable: false },
      { pubkey: accounts.initializerAtaA, isSigner: false, isWritable: true },
      { pubkey: accounts.takerAtaB, isSigner: false, isWritable: true },
      { pubkey: accounts.escrow, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultA, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultB, isSigner: false, isWritable: true },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([232, 219, 223, 41, 219, 236, 220, 190]) // cancel discriminator
  });

  const transaction = new Transaction()
    .add(priorityFeeIx)
    .add(cancelIx);

  const latestBlockhash = await connection.getLatestBlockhash();
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
  transaction.feePayer = initializerKeypair.publicKey;
  
  return await sendAndConfirmTransaction(
    connection,
    transaction,
    [initializerKeypair],
    {
      commitment: 'confirmed',
      skipPreflight: false,
      maxRetries: 5,
      preflightCommitment: 'processed'
    }
  );
}

export class TokenPollingService {
  private static instance: TokenPollingService;
  private pollingInterval: NodeJS.Timeout | null = null;
  private state: PollingState;
  private stateFilePath: string;
  private client: any;
  private negotiationHandler?: any;
  private fileWatcher: fs.FSWatcher | null = null;
  private isProcessingFileChange = false;
  
  private constructor(
    private connection: Connection,
    private pollIntervalMs: number = 60000 
  ) {
    const __dirname = path.resolve();
    this.stateFilePath = path.resolve(__dirname, 'escrow_data', 'polling-state.json');
    
    this.ensureStateFileExists();
    this.state = this.loadState();
    this.resumePolling();
    
    this.startFileWatcher();
  }

  public static getInstance(connection: Connection, pollIntervalMs?: number): TokenPollingService {
    if (!TokenPollingService.instance) {
      TokenPollingService.instance = new TokenPollingService(connection, pollIntervalMs);
    }
    return TokenPollingService.instance;
  }

  private ensureStateFileExists(): void {
    const dir = path.dirname(this.stateFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.stateFilePath)) {
      this.saveState({
        tasks: [],
        lastPollTime: 0
      });
    }
  }

  private safeReadState(): PollingState {
    try {
      const data = readFileSync(this.stateFilePath, 'utf8');
      return JSON.parse(data);
    } catch (mainError) {
      elizaLogger.error('Error reading main state file:', mainError);
      
      try {
        const backupPath = path.join(tmpdir(), 'polling-state.backup.json');
        if (fs.existsSync(backupPath)) {
          const backupData = readFileSync(backupPath, 'utf8');
          const backupState = JSON.parse(backupData);
          
          this.safeWriteState(backupState);
          elizaLogger.info('Restored from backup file');
          return backupState;
        }
      } catch (backupError) {
        elizaLogger.error('Error reading backup file:', backupError);
      }
      
      return { tasks: [], lastPollTime: 0 };
    }
  }

  private safeWriteState(state: PollingState): void {
    const tempPath = path.join(tmpdir(), `polling-state.${Date.now()}.tmp`);
    const backupPath = path.join(tmpdir(), 'polling-state.backup.json');
    
    try {
      writeFileSync(tempPath, JSON.stringify(state, null, 2));
      
      if (fs.existsSync(this.stateFilePath)) {
        fs.copyFileSync(this.stateFilePath, backupPath);
      }
      
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      try {
        fs.renameSync(tempPath, this.stateFilePath);
      } catch (error: any) {
        if (error.code === 'EXDEV') {
          fs.copyFileSync(tempPath, this.stateFilePath);
          fs.unlinkSync(tempPath);
        } else {
          throw error;
        }
      }
      
    } catch (error) {
      elizaLogger.error('Error writing state file:', error);
      throw error;
    } finally {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch (cleanupError) {
          elizaLogger.error('Error cleaning up temp file:', cleanupError);
        }
      }
    }
  }

  private loadState(): PollingState {
    return this.safeReadState();
  }

  private saveState(state?: PollingState): void {
    try {
      if (this.fileWatcher) {
        this.fileWatcher.close();
      }
      
      this.safeWriteState(state || this.state);
      
      this.startFileWatcher();
    } catch (error) {
      elizaLogger.error('Error saving polling state:', error);
    }
  }

  public addPollingTask(
    associatedTokenAccount: string,
    mintAddress: string,
    expectedAmount: string,
    accounts: {
        escrow: string;
        initializer: string;
        taker: string;
        mintA: string;
        initializerAtaA: string;
        initializerAtaB: string;
        takerAtaA: string;
        takerAtaB: string;
        vaultA: string;
        initializerSecretKey: number[];
        tweet: {
            id: string;
            text: string;
            username: string;
            timestamp: number;
            conversationId: string;
        };
        thread?: Array<{
            id: string;
            text: string;
            username: string;
            timestamp: number;
        }>;
        message?: {
            content: { text: string };
            agentId: string;
            userId: string;
            roomId: string;
        };
        tradeDetails?: {
            sentAmount: number;
            sentSymbol: string;
            receivedAmount: number;
            receivedSymbol: string;
        };
    },
    threshold: number = 0.95
  ): void {
    const existingTask = this.state.tasks.find(task => task.tweet?.id === accounts.tweet.id);
    if (existingTask) {
        console.log(`Task already exists for tweet ${accounts.tweet.id}`);
        return;
    }

    const task: PollingTask = {
        associatedTokenAccount,
        mintAddress,
        expectedAmount,
        threshold,
        status: 'pending',
        ...accounts
    };

    this.state.tasks.push(task);
    this.saveState();

    if (!this.pollingInterval) {
        this.startPolling();
    }
  }

  public removePollingTask(tweetId: string): void {
    const task = this.state.tasks.find(t => t.tweet?.id === tweetId);
    if (task) {
        task.status = 'cancelled';
        this.saveState();
    }
  }

  private async checkTokenBalance(task: PollingTask): Promise<boolean> {
    try {
        console.log(`\nChecking balance for task:
            Token: ${task.mintAddress}
            Vault: ${task.associatedTokenAccount}
            Expected: ${task.expectedAmount}
            Threshold: ${task.threshold * 100}%`);

        const mintInfo = await getMint(this.connection, new PublicKey(task.mintAddress));
        
        const accountInfo = await this.connection.getParsedAccountInfo(
            new PublicKey(task.associatedTokenAccount)
        );

        if (!accountInfo.value || !('parsed' in accountInfo.value.data)) {
            console.log(`No token account found at ${task.associatedTokenAccount}`);
            return false;
        }

        const tokenData = accountInfo.value.data.parsed;
        const currentAmount = new BigNumber(tokenData.info.tokenAmount.amount);
        const expectedUiAmount = new BigNumber(task.expectedAmount);
        const expectedAmount = new BigNumber(task.expectedAmount).dividedBy(Math.pow(10, mintInfo.decimals));
        
        const currentUiAmount = currentAmount.dividedBy(Math.pow(10, mintInfo.decimals));
        const thresholdAmount = expectedUiAmount.multipliedBy(task.threshold);

        task.lastCheckedAmount = currentAmount.toString();
        task.lastCheckedTime = Date.now()

        console.log(`Balance check results:
            Current (raw): ${currentAmount.toString()}
            Current (UI): ${currentUiAmount.toString()}
            Expected (raw): ${expectedAmount.toString()}
            Expected (UI): ${expectedUiAmount.toString()}
            Threshold (UI): ${thresholdAmount.toString()}
            Progress: ${currentUiAmount.dividedBy(expectedUiAmount).multipliedBy(100).toFixed(2)}%`);

        const isThresholdMet = currentUiAmount.isGreaterThanOrEqualTo(thresholdAmount);
        if (isThresholdMet) {
            elizaLogger.success(`Threshold met: ${isThresholdMet}`);
        }

        return isThresholdMet;
    } catch (error) {
        elizaLogger.error('Error checking token balance:', error);
        task.error = error instanceof Error ? error.message : 'Unknown error';
        return false;
    }
  }

  private async executeActions(task: PollingTask): Promise<void> {
    try {
      const accounts = {
        initializer: new PublicKey(task.initializer),
        taker: new PublicKey(task.taker),
        mintA: new PublicKey(task.mintA),
        mintB: new PublicKey(task.mintAddress),
        initializerAtaA: new PublicKey(task.initializerAtaA),
        initializerAtaB: new PublicKey(task.initializerAtaB),
        takerAtaA: new PublicKey(task.takerAtaA),
        takerAtaB: new PublicKey(task.takerAtaB),
        escrow: new PublicKey(task.escrow),
        vaultA: new PublicKey(task.vaultA),
        vaultB: new PublicKey(task.associatedTokenAccount),
      };

      const initializerKeypair = Keypair.fromSecretKey(
        Uint8Array.from(task.initializerSecretKey)
      );

      const txid = await executeExchange(
        this.connection,
        accounts,
        initializerKeypair
      );
      
      console.log(`Exchange executed: ${txid}`);
      task.status = 'completed';
      task.completedTime = Date.now();

      if (this.negotiationHandler && task.tweet.id) {
        await this.negotiationHandler.notifyEscrowComplete(task);
      }
    } catch (error) {
      elizaLogger.error('Error executing exchange:', error);
      task.status = 'failed';
      task.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  private async pollTasks(): Promise<void> {
    const fileState = this.loadState();
    
    const fileTaskMap = new Map(
        fileState.tasks.map(task => [task.escrow, task])
    );
    const memoryTaskMap = new Map(
        this.state.tasks.map(task => [task.escrow, task])
    );

    this.state.tasks = Array.from(new Set([...fileTaskMap.keys(), ...memoryTaskMap.keys()])).map(escrow => {
        const fileTask = fileTaskMap.get(escrow);
        const memoryTask = memoryTaskMap.get(escrow);
        
        if (fileTask && memoryTask) {
            if (fileTask.status !== memoryTask.status) {
                return { ...memoryTask, status: fileTask.status };
            }
            return memoryTask;
        }
        return fileTask || memoryTask!;
    });

    const remainingTasks: PollingTask[] = [];

    for (const task of this.state.tasks) {
        if (task.status === 'request_cancel') {
            console.log("Requesting cancellation for escrow", task.escrow);
            try {
                const initializerKeypair = Keypair.fromSecretKey(
                    Uint8Array.from(task.initializerSecretKey)
                );

                await this.cancelEscrow(
                    initializerKeypair,
                    new PublicKey(task.mintA),
                    new PublicKey(task.mintAddress),
                    new PublicKey(task.initializerAtaA),
                    new PublicKey(task.takerAtaB),
                    new PublicKey(task.escrow),
                    new PublicKey(task.vaultA),
                    new PublicKey(task.associatedTokenAccount),
                    new PublicKey(task.taker)
                );

                task.status = 'cancelled';
            } catch (error) {
                elizaLogger.error('Error cancelling escrow during polling:', error);
                task.status = 'failed';
                task.error = error instanceof Error ? error.message : 'Unknown error during cancellation';
            }
            continue;
        }

        if (task.status === 'pending') {
            const thresholdMet = await this.checkTokenBalance(task);
            if (thresholdMet) {
                await this.executeActions(task);
            }
        }

        if (task.status === 'pending') {
            remainingTasks.push(task);
        }
    }

    this.state.tasks = [
        ...fileState.tasks.filter(t => 
            t.status === 'completed' || 
            t.status === 'failed' || 
            t.status === 'cancelled'
        ),
        ...this.state.tasks.filter(t => 
            t.status === 'completed' || 
            t.status === 'failed' || 
            t.status === 'cancelled'
        ),
        ...remainingTasks
    ];

    this.state.tasks = Array.from(
        new Map(this.state.tasks.map(task => [task.escrow, task])).values()
    );
    
    this.state.lastPollTime = Date.now();
    this.saveState();

    if (remainingTasks.length === 0) {
        console.log('No more active tasks, stopping polling');
        this.stopPolling();
    }
  }

  private resumePolling(): void {
    const activeTasks = this.state.tasks.filter(task => 
      task.status === 'pending' || task.status === 'request_cancel'
    );
    
    if (activeTasks.length > 0) {
      console.log(`Resuming ${activeTasks.length} active polling tasks...`);
      this.startPolling();
    }
  }

  public startPolling(): void {
    if (this.pollingInterval) {
      console.log('Polling already in progress');
      return;
    }

    const activeTasks = this.state.tasks.filter(task => 
      task.status === 'pending' || task.status === 'request_cancel'
    );
    
    if (activeTasks.length === 0) {
      console.log('No active tasks to poll');
      return;
    }

    console.log(`Starting polling for ${activeTasks.length} tasks...`);
    this.pollingInterval = setInterval(
      () => this.pollTasks(),
      this.pollIntervalMs
    );
  }

  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  public getActiveTasks(): PollingTask[] {
    return this.state.tasks.filter(task => 
      task.status === 'pending' || task.status === 'request_cancel'
    );
  }

  public getAllTasks(): PollingTask[] {
    return [...this.state.tasks];
  }

  public async initializeEscrow(
    initializerKeypair: Keypair,
    taker: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey,
    initializerAmount: number,
    takerAmount: number
  ): Promise<{ 
    transaction: Transaction;
    escrow: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
  }> {
    const seed = randomBytes(8);
    const escrow = PublicKey.findProgramAddressSync(
      [Buffer.from("state"), seed],
      PROGRAM_ID
    )[0];

    const vaultA = await getAssociatedTokenAddress(mintA, escrow, true);
    const vaultB = await getAssociatedTokenAddress(mintB, escrow, true);
    const initializerAtaA = await getAssociatedTokenAddress(mintA, initializerKeypair.publicKey);

    const tx = await executeInitialize(
      this.connection,
      {
        initializer: initializerKeypair.publicKey,
        mintA,
        mintB,
        initializerAtaA,
        escrow,
        vaultA,
        vaultB,
      },
      initializerKeypair,
      Array.from(seed),
      initializerAmount,
      takerAmount,
      taker
    );

    return {
      transaction: tx,
      escrow,
      vaultA,
      vaultB
    };
  }

  public async transferToVault(
    takerKeypair: Keypair,
    takerAtaB: PublicKey,
    mintB: PublicKey,
    vaultB: PublicKey,
    amount: number,
    decimals: number = 6
  ): Promise<string> {
    return await executeTransfer(
      this.connection,
      takerAtaB,
      mintB,
      vaultB,
      takerKeypair,
      amount,
      decimals
    );
  }

  public async setupEscrow(
    initializerAmount: number = 1e6,
    takerAmount: number = 1e6,
    initializer: Keypair,
    taker: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey
  ): Promise<{
    initializer: Keypair;
    taker: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
    escrow: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
    initializerAtaA: PublicKey;
    initializerAtaB: PublicKey;
    takerAtaA: PublicKey;
    takerAtaB: PublicKey;
    tweet?: {
      id: string;
      text: string;
      username: string;
      timestamp: number;
      conversationId: string;
    };
    thread?: Array<{
      id: string;
      text: string;
      username: string;
      timestamp: number;
    }>;
    transactionId: string;
  }> {
    try {
      const mintAInfo = await getMint(this.connection, mintA);
      const mintBInfo = await getMint(this.connection, mintB);

      const rawInitializerAmount = initializerAmount * Math.pow(10, mintAInfo.decimals);
      const rawTakerAmount = takerAmount * Math.pow(10, mintBInfo.decimals);

      console.log("Amounts:", {
        rawInitializerAmount,
        rawTakerAmount,
        initializerAmount,
        takerAmount
      });

      const initializerAtaA = await getAssociatedTokenAddress(mintA, initializer.publicKey);
      const initializerAtaB = await getAssociatedTokenAddress(mintB, initializer.publicKey);
      const takerAtaA = await getAssociatedTokenAddress(mintA, taker);
      const takerAtaB = await getAssociatedTokenAddress(mintB, taker);

      const { transaction, escrow, vaultA, vaultB } = await this.initializeEscrow(
        initializer,
        taker,
        mintA,
        mintB,
        rawInitializerAmount,
        rawTakerAmount
      );

      transaction.feePayer = initializer.publicKey;

      const latestBlockhash = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
      
      const MAX_RETRIES = 3;
      let lastError;

      for (let i = 0; i < MAX_RETRIES; i++) {
        try {
          const simTx = new Transaction();
          simTx.feePayer = initializer.publicKey;
          simTx.recentBlockhash = latestBlockhash.blockhash;
          
          simTx.add(...transaction.instructions);

          const simulation = await this.connection.simulateTransaction(simTx);
          if (simulation.value.err) {
            console.error("Initialize escrow transaction simulation failed:", simulation.value.err);
            console.log("Simulation logs:", simulation.value.logs);
            throw new Error(`Initialize escrow transaction simulation failed: ${simulation.value.err}`);
          }
          
          const finalTx = new Transaction();
          finalTx.feePayer = initializer.publicKey;
          finalTx.recentBlockhash = latestBlockhash.blockhash;
          finalTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

          const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: PRIORITY_FEE
          });
          finalTx.add(priorityFeeIx);
          
          finalTx.add(...transaction.instructions);
          
          const signature = await sendAndConfirmTransaction(
            this.connection,
            finalTx,
            [initializer],
            {
              commitment: 'confirmed',
              skipPreflight: false,
              maxRetries: 5,
              preflightCommitment: 'processed'
            }
          );
          
          const tx = await this.connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0
          });
          
          if (tx?.meta?.err) {
            console.error("Transaction error:", tx.meta.err);
          }
          
          if (tx?.meta?.logMessages) {
            console.log("Transaction logs:", tx.meta.logMessages);
          }

          return {
            initializer,
            taker,
            mintA,
            mintB,
            escrow,
            vaultA,
            vaultB,
            initializerAtaA,
            initializerAtaB,
            takerAtaA,
            takerAtaB,
            transactionId: signature
          };

        } catch (txError: any) {
          console.error(`Attempt ${i + 1} failed:`, txError);
          lastError = txError;

          if (txError instanceof Error && 
            txError.message.includes('block height exceeded')) {
            const newBlockhash = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = newBlockhash.blockhash;
            transaction.lastValidBlockHeight = newBlockhash.lastValidBlockHeight;
            continue;
          }

          throw txError;
        }
      }

      throw lastError;
    } catch (error: any) {
      console.error("Setup error:", error);
      console.error("Error type:", typeof error);
      console.error("Error keys:", Object.keys(error));
      
      if (error.logs) {
        console.error("Program logs:", error.logs);
      }
      
      throw error;
    }
  }

  public setNegotiationHandler(handler: any) {
    this.negotiationHandler = handler;
  }

  public async cancelEscrow(
    initializerKeypair: Keypair,
    mintA: PublicKey,
    mintB: PublicKey,
    initializerAtaA: PublicKey,
    takerAtaB: PublicKey,
    escrow: PublicKey,
    vaultA: PublicKey,
    vaultB: PublicKey,
    taker: PublicKey
  ): Promise<string> {
    const accounts = {
      initializer: initializerKeypair.publicKey,
      taker,
      mintA,
      mintB,
      initializerAtaA,
      takerAtaB,
      escrow,
      vaultA,
      vaultB,
    };

    try {
      const txid = await executeCancel(
        this.connection,
        accounts,
        initializerKeypair
      );

      console.log(`Escrow cancelled successfully: ${txid}`);
      
      this.state.tasks = this.state.tasks.filter(task => 
        task.escrow !== escrow.toString() || 
        task.status !== 'pending'
      );
      this.saveState();

      return txid;
    } catch (error) {
      elizaLogger.error('Error cancelling escrow:', error);
      throw error;
    }
  }

  public requestCancellation(escrowAddress: string): void {
    const task = this.state.tasks.find(t => 
      t.escrow === escrowAddress && 
      (t.status === 'pending' || t.status === 'failed')
    );

    if (!task) {
      throw new Error(`No active task found for escrow: ${escrowAddress}`);
    }

    task.status = 'request_cancel';
    console.log(`Cancellation requested for escrow: ${escrowAddress}`);
    this.saveState();
  }

  public async verifyEscrowSetup(
    transactionId: string,
    mintA: PublicKey,
    mintB: PublicKey,
    expectedAmountA: number,
    expectedAmountB: number
  ): Promise<{ isSecure: boolean; isFunded: boolean; remainingAmount: number; vaultB: PublicKey | undefined }> {
    try {
      const mintAInfo = await getMint(this.connection, mintA);
      const mintBInfo = await getMint(this.connection, mintB);

      const rawExpectedAmountA = Math.floor(expectedAmountA * Math.pow(10, mintAInfo.decimals));
      const rawExpectedAmountB = Math.floor(expectedAmountB * Math.pow(10, mintBInfo.decimals));

      const transaction = await this.connection.getParsedTransaction(transactionId, {
        maxSupportedTransactionVersion: 0
      });

      if (!transaction?.meta?.postTokenBalances) {
        console.error("Transaction or token balances not found");
        return { isSecure: false, isFunded: false, remainingAmount: expectedAmountB, vaultB: undefined };
      }

      const accountKeys = transaction.transaction.message.accountKeys.map(key => 
        new PublicKey(typeof key === 'string' ? key : key.pubkey || key.toString())
      );

      const escrowAccount = await Promise.all(
        accountKeys.map(async key => {
          const info = await this.connection.getAccountInfo(key);
          return info?.owner.equals(PROGRAM_ID) ? key : null;
        })
      ).then(results => results.find(key => key !== null));

      if (!escrowAccount) {
        console.error("Could not find escrow account owned by our program");
        return { isSecure: false, isFunded: false, remainingAmount: expectedAmountB, vaultB: undefined };
      }

      const vaultAAccount = transaction.meta.postTokenBalances.find(
        balance => balance.mint === mintA.toString() && 
        balance.owner === escrowAccount.toString()
      );
      const vaultBAccount = transaction.meta.postTokenBalances.find(
        balance => balance.mint === mintB.toString() && 
        balance.owner === escrowAccount.toString()
      );

      if (!vaultAAccount || !vaultBAccount) {
        console.error("Could not find vault accounts for mints");
        return { isSecure: false, isFunded: false, remainingAmount: expectedAmountB, vaultB: undefined };
      }

      const vaultA = accountKeys[vaultAAccount.accountIndex];
      const vaultB = accountKeys[vaultBAccount.accountIndex];

      const vaultAInfo = await this.connection.getAccountInfo(vaultA);
      const vaultBInfo = await this.connection.getAccountInfo(vaultB);
      
      if (!vaultAInfo || !vaultBInfo) {
        console.error("One or both vault accounts not found");
        return { isSecure: false, isFunded: false, remainingAmount: expectedAmountB, vaultB: undefined };
      }

      const balanceA = await this.connection.getTokenAccountBalance(vaultA);
      const balanceB = await this.connection.getTokenAccountBalance(vaultB);

      const isFunded = Math.abs(Number(balanceA.value.amount) - rawExpectedAmountA) < 1000;
      
      const remainingAmount = (rawExpectedAmountB - (Number(balanceB.value.amount) || 0)) / Math.pow(10, mintBInfo.decimals);

      const escrowInfo = await this.connection.getAccountInfo(escrowAccount);

      const isSecure = escrowInfo?.owner.equals(PROGRAM_ID) && 
                       (await this.connection.getAccountInfo(vaultA))?.data.length === 165 &&
                       (await this.connection.getAccountInfo(vaultB))?.data.length === 165;

      return {
        isSecure,
        isFunded,
        remainingAmount,
        vaultB
      };
    } catch (error) {
      console.error("Error verifying escrow setup:", error);
      return { isSecure: false, isFunded: false, remainingAmount: expectedAmountB, vaultB: undefined };
    }
  }

  public async verifyAndCompleteEscrow(
    takerKeypair: Keypair,
    transactionId: string,
    mintA: PublicKey,
    mintB: PublicKey,
    expectedAmountA: number,
    expectedAmountB: number
  ): Promise<boolean> {
    try {
        const verification = await this.verifyEscrowSetup(transactionId, mintA, mintB, expectedAmountA, expectedAmountB);
        if (!verification.isSecure || !verification.isFunded) { 
            console.error("Escrow setup verification failed: ", verification);
            return false;
        }

        if (verification.vaultB && verification.remainingAmount > 0) {
            const mintInfo = await getMint(this.connection, mintB);
            const takerAtaB = await getAssociatedTokenAddress(mintB, takerKeypair.publicKey);

            const rawAmount = Math.floor(verification.remainingAmount * Math.pow(10, mintInfo.decimals));

            try {
                const transferTxId = await this.transferToVault(
                    takerKeypair, 
                    takerAtaB, 
                    mintB, 
                    verification.vaultB, 
                    rawAmount, 
                    mintInfo.decimals
                );
                console.log(`Transfer to vault successful. Transaction ID: ${transferTxId}`);
                return true;
            } catch (transferError) {
                console.error("Failed to transfer to vault:", transferError);
                return false;
            }
        } else {
            console.error("Escrow setup verification failed: No vaultB or remaining amount is 0", {
                vaultB: verification.vaultB?.toString(),
                remainingAmount: verification.remainingAmount
            });
            return false;
        }
    } catch (error) {
        console.error("Error verifying and completing escrow:", error);
        return false;
    }
  }

  private async handleFileChange(): Promise<void> {
    if (this.isProcessingFileChange) {
      return;
    }

    try {
      this.isProcessingFileChange = true;
      
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const fileState = this.safeReadState();
      if (!fileState || !Array.isArray(fileState.tasks)) {
        elizaLogger.error('Invalid state file format');
        return;
      }

      const memoryTaskMap = new Map(
        this.state.tasks.map(task => [task.escrow, task])
      );

      for (const fileTask of fileState.tasks) {
        if (!fileTask.escrow) continue;
        
        const memoryTask = memoryTaskMap.get(fileTask.escrow);
        
        if (!memoryTask || memoryTask.status !== fileTask.status) {
          if (fileTask.status === 'pending') {
            elizaLogger.info(`Task ${fileTask.escrow} needs polling (status: ${fileTask.status})`);
            this.state.tasks = this.state.tasks.filter(t => t.escrow !== fileTask.escrow);
            this.state.tasks.push(fileTask);
            
            if (!this.pollingInterval) {
              this.startPolling();
            }
          }
        }
      }

      this.state.tasks = this.state.tasks.map(memoryTask => {
        const fileTask = fileState.tasks.find(t => t.escrow === memoryTask.escrow);
        if (fileTask && memoryTask.status !== 'pending') {
          return { ...memoryTask, ...fileTask };
        }
        return memoryTask;
      });

    } catch (error) {
      elizaLogger.error('Error processing file change:', error);
    } finally {
      this.isProcessingFileChange = false;
    }
  }

  private startFileWatcher(): void {
    if (this.fileWatcher) {
      return;
    }

    this.fileWatcher = watch(this.stateFilePath, (eventType, filename) => {
      if (eventType === 'change') {
        this.handleFileChange();
      }
    });

    this.fileWatcher.on('error', (error) => {
      elizaLogger.error('Error watching polling state file:', error);
    });
  }

  private stopFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }
} 