# Eliza 🤖

<div align="center">
  <img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />
</div>

<div align="center">
  
  📖 [Documentation](https://ai16z.github.io/eliza/) | 🎯 [Examples](https://github.com/thejoven/awesome-eliza)
  
</div>

## 🌍 README Translations

[中文说明](./README_CN.md) | [日本語の説明](./README_JA.md) | [한국어 설명](./README_KOR.md) | [Français](./README_FR.md) | [Português](./README_PTBR.md) | [Türkçe](./README_TR.md) | [Русский](./README_RU.md) | [Español](./README_ES.md) | [Italiano](./README_IT.md)

## ✨ Features

-   🛠️ Full-featured Discord, Twitter and Telegram connectors
-   🔗 Support for every model (Llama, Grok, OpenAI, Anthropic, etc.)
-   👥 Multi-agent and room support
-   📚 Easily ingest and interact with your documents
-   💾 Retrievable memory and document store
-   🚀 Highly extensible - create your own actions and clients
-   ☁️ Supports many models (local Llama, OpenAI, Anthropic, Groq, etc.)
-   📦 Just works!

## 🎯 Use Cases

-   🤖 Chatbots
-   🕵️ Autonomous Agents
-   📈 Business Process Handling
-   🎮 Video Game NPCs
-   🧠 Trading

## 🚀 Quick Start

### Prerequisites

-   [Python 2.7+](https://www.python.org/downloads/)
-   [Node.js 22+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
-   [pnpm](https://pnpm.io/installation)

> **Note for Windows Users:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install-manual) is required.

### Use the Starter (Recommended)

```bash
git clone https://github.com/ai16z/eliza-starter.git

cp .env.example .env

pnpm i && pnpm start
```

Then read the [Documentation](https://ai16z.github.io/eliza/) to learn how to customize your Eliza.

### Manually Start Eliza (Only recommended if you know what you are doing)

```bash
# Clone the repository
git clone https://github.com/ai16z/eliza.git

# Checkout the latest release
# This project iterates fast, so we recommend checking out the latest release
git checkout $(git describe --tags --abbrev=0)
```

### Edit the .env file

Copy .env.example to .env and fill in the appropriate values.

```
cp .env.example .env
```

Note: .env is optional. If your planning to run multiple distinct agents, you can pass secrets through the character JSON

### Automatically Start Eliza

This will run everything to setup the project and start the bot with the default character.

```bash
sh scripts/start.sh
```

### Edit the character file

1. Open `agent/src/character.ts` to modify the default character. Uncomment and edit.

2. To load custom characters:
    - Use `pnpm start --characters="path/to/your/character.json"`
    - Multiple character files can be loaded simultaneously

### Manually Start Eliza

```bash
pnpm i
pnpm build
pnpm start

# The project iterates fast, sometimes you need to clean the project if you are coming back to the project
pnpm clean
```

#### Additional Requirements

You may need to install Sharp. If you see an error when starting up, try installing it with the following command:

```
pnpm install --include=optional sharp
```

### Community & contact

-   [GitHub Issues](https://github.com/ai16z/eliza/issues). Best for: bugs you encounter using Eliza, and feature proposals.
-   [Discord](https://discord.gg/ai16z). Best for: sharing your applications and hanging out with the community.

## Contributors

<a href="https://github.com/ai16z/eliza/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=ai16z/eliza" />
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ai16z/eliza&type=Date)](https://star-history.com/#ai16z/eliza&Date)

# Negotiations Overview

This document provides an overview of how the negotiation flow works. The negotiation flow enables an Eliza agent to handle negotiating a trade with another twitter user and escrowing the funds.

## Purpose of negotiations.ts

• Centralizes the logic for overseeing an escrow-based transaction.
• Integrates with the Eliza Agent’s memory and conversation context to keep track of negotiation states.
• On a successful negotiation, it adds the user to an "ally" memory, which can be made accessbile to the agent for future Twitter posts.

## Flow

1. Initialization  
   - A new negotiation instance is created (for example, triggered by a tweet asking to trade tokens).  
   - The “negotiations.ts” module registers the new negotiation.

2. Polling for Updates  
   - The TokenPollingService monitors on-chain balances associated with the escrow.  
   - It calls back into the negotiation logic when the token threshold is met. 

3. Completing the Escrow  
   - Once the threshold is met (for example, the user deposits the required amount of tokens into a vault), negotiations.ts triggers the final exchange.  
   - If successful, calls negotiationHandler.notifyEscrowComplete(task).  
   - The escrow or trade is marked as completed, and the counterparty is notified.

# Extended Negotiations Overview
## Whitelisting and Blacklisting

Negotiations requires a filter to either allow or disallow certain users from interacting with the escrow logic. This system is provided through whitelists and blacklists:

1. Whitelisted Users  
   - Stored in agent/negotiation_settings.json under key "whitelisted_users". 
   - Each whitelisted user has the fields:  
     - username: The user’s Twitter username.  
     - wallet_address: Where the user holds tokens on-chain.  
     - token_symbol and contract_address: Identify the token that user intends to trade.  
     - tier: An integer that indicates the user’s “tier” in your negotiation logic (see the example negotiation_settings.json below).

   - The NegotiationHandler references this whitelist to check if a user is allowed to participate in trading and to look up their on-chain addresses and tokens.

2. Blacklisted Users  
   - Maintained in a separate YAML file in agent/engagement/blacklisted_interactions.yaml
   - Any user on the blacklist is excluded from negotiations. The agent will send them a message using nonWhitelistedUserPost if they attempt to negotiate.
---

## agent/negotiation_settings.json
The file negotiation_settings.json contains essential settings and parameters for the negotiation logic: 

1. whitelisted_users 
   - The users allowed to participate in negotiations -- each entry defines user details. 

2. counterparty_tiers 
   - Defines multiple “tiers” for different classes of whitelisted users.  
   - Each tier has the fields:
     - refractory_period_days: Minimum “cool-down” between negotiations for a user.  
     - min_offer_percentage and max_offer_percentage: The negotiation logic applies random calculations between these percentages to generate the initial offer as a percentage of the fair price of our max offer amount.
     - max_offer_amount: Maximum number of tokens from our side.  
     - max_negotiations: How many rounds of offers/counteroffers to allow at >= 95% of the max_offer_amount before finalizing or rejecting a deal.

3. our_token 
   - symbol: The symbol for our agent’s token.  
   - contract_address: On-chain mint address for our agent’s token.  
   - minimum_balance: Ensures we don’t dip below a certain token balance while offering trades. If the balance is below this threshold, a warning will be logged in console and the max_offer_amount will be reduced to 25% of the balance.

### Example configuration:
```json
{
    "whitelisted_users": [
        {
            "username": "0xAcoylte",
            "wallet_address": "4dau6xyUKJjg8CoqCwmC7qv3rsNLvT9ENeMusWvHcrvQ",
            "token_symbol": "GOAT",
            "contract_address": "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump",
            "tier": 1
        }
    ],
    "counterparty_tiers": [
        {
            "refractory_period_days": 30,
            "min_offer_percentage": 80,
            "max_offer_percentage": 90,
            "max_offer_amount": 1000,
            "max_negotiations": 3
        },
        {
            "refractory_period_days": 30,
            "min_offer_percentage": 80,
            "max_offer_percentage": 90,
            "max_offer_amount": 500,
            "max_negotiations": 3
        },
        {
            "refractory_period_days": 30,
            "min_offer_percentage": 80,
            "max_offer_percentage": 90,
            "max_offer_amount": 100,
            "max_negotiations": 3
        }
    ],
    "our_token": {
        "symbol": "REX",
        "contract_address": "CNKEXXypBC66cZ111Mg3JUxyczXS1E9T6MWEufzQZVMo",
        "minimum_balance": 10000
    }
}
```

---

## Calculating an Offer

1. Fetching Token Prices  
   - The negotiation logic calls getTokenPrices() to retrieve on-chain pricing data (using fetchTokenData and getAveragedPrice).  
   - Returns a structure with:
     - our_token_price: USD price of the agent’s token.  
     - counterparty_token_price: USD price of the counterparty’s token.

2. Determining Fair Value  
   - A “fair” price ratio is computed as:
     fair_price = our_token_price / counterparty_token_price  

3. Tiers and Negotiation Logic  
   - The user’s assigned tier merges the above price data with counters for negotiation attempts, a maximum offer amount, and the percentage range to choose from.  
   - For example, if the tier has min_offer_percentage of 90% and max_offer_percentage of 95%, the agent’s initial or next offer might pick a random factor in [90%, 95%] of the maximum.  
   - Over multiple rounds of negotiation, the agent gradually approaches the maximum offering set in max_offer_amount.  
   - If the final round is reached (95% of max_offer_amount) and the deal is still not accepted, the agent either attempts negotiations up to its max_negotiations or terminates the negotiation.

4. Checking Fair Pricing  
   - During each step, the agent ensures that the proposed trade is within a 5% threshold of the fair value. If it falls outside that threshold, the negotiation logic rejects the deal and counters with a new offer if we have not reached the max_negotiations.

---

## Flow Overview 
1. User is found in whitelisted_users, confirmed not to be blacklisted.  
2. NegotiationHandler fetches the user’s tier and loads configuration for that tier (counterparty_tiers).  
3. getTokenPrices() obtains up-to-date token pricing.  
4. calculateOffer() performs random or incremental steps within the configured min_offer_percentage–max_offer_percentage range, referencing the user’s tier.  
5. The agent sends an offer tweet or message, formatted with the amounts and context.  
6. If the user counters, the agent reevaluates the new proposed amounts.  
7. The flow continues until either a final offer is accepted (triggering escrow completion) or it fails (agent logs a rejection).

# Negotiation Templates Overview
## Within the NegotiationHandler, several template files provide predefined message structures or text prompts for distinct stages of the negotiation flow. 
---

## 1. acceptDealTemplate
• Purpose: When the user accepts the proposed offer, this template provides a message acknowledging the acceptance and outlining any remaining steps before the escrow is completed.  
• Usage Example:  
  - After the counterparty proposes an offer and the user accepts, NegotiationHandler uses the acceptDealTemplate

---

## 2. finalTradeOfferTemplate
• Purpose: Sent when the agent is making its last or near-final offer in a negotiation (when the offer is > 95% of the max_offer_amount).
• Usage Example:  
  - If the agent is at > 95% of the max_offer_amount, the finalTradeOfferTemplate is to inform the counterparty that this is the final offer, but depending on the number of retries allowed (max_negotiations), the agent may continue to negotiate up until the max_negotiations is reached.

---

## 3. initialTradeOfferTemplate
• Purpose: The first offer the agent makes once a conversation indicates interest in trading
• Usage Example:  
  - When the agent sees a tweet that indicates a new trade request

---

## 4. nextTradeOfferTemplate
• Purpose: Used when the agent needs to make a “counter” offer during the negotiation if the counterparty rejects the initial offer.
• Usage Example:  
  - For example, if the counterparty replies, “Too low, can you do better?” the agent consults tier-based logic, calculates a new amount, and sends the nextTradeOfferTemplate with updated pricing and instructions.

---

## 5. negotiationsFailedTemplate
• Purpose: Communicates that the negotiation flow has concluded without success (max_negotiations reached)

---

## 6. escrowCompleteTemplate
• Purpose: Notifies all parties that on-chain conditions have been met (i.e., token amounts have arrived in the escrow vault, and both sides of the trade are complete). This is sent after the TokenPollingService detects that escrow thresholds were fulfilled.  

---

## 7. initiatedTransferTemplate
• Purpose: Used primarily when the counterparty indicates they have initiated the escrow smart contract and by providing a transaction ID indicating as such. 

---

## 8. nonWhitelistedUserTemplate
• Purpose: Sent to a counterparty who attempt a negotiation but is on the blacklist.

---

# Smart Contract & Token Polling States

## Smart Contract Overview

The negotiation system uses a Solana escrow smart contract (program ID: "7xPuVJEKsK3Y7fTbDVhVgzBmHrzfATQSerpsyKe3aMma") that enables secure token swaps between two parties.

📝 [View Smart Contract Source](https://github.com/dixitqueDeusFiatLux/eliza_escrow_smart_contract)

### Key Accounts Structure

```typescript
initializer: PublicKey, // Our agent, from our .env public/private key -- used to initialize the smart contract
taker: PublicKey, // Counterparty accepting the trade
mintA: PublicKey, // Our token's mint address
mintB: PublicKey, // Counterparty's token's mint address
initializerAtaA: PublicKey, // Initializer's token A account
initializerAtaB: PublicKey, // Initializer's token B account
takerAtaA: PublicKey, // Taker's token A account
takerAtaB: PublicKey, // Taker's token B account
escrow: PublicKey, // Main escrow account
vaultA: PublicKey, // Temporary vault for token A (our agent's token)
vaultB: PublicKey, // Temporary vault for token B (counterparty's token)
```

### Smart Contract Flow

1. **Initialization Phase**
   - Initializer creates the escrow account and vault
   - Deposits their tokens into vaultA
   - Sets the expected amount of tokenB they want to receive with a 5% buffer

2. **Exchange Phase**
   - Taker verifies the escrow setup is secure
   - Deposits their tokens into vaultB
   - Smart contract performs atomic swap:
     - Moves tokens from vaultA → takerAtaA
     - Moves tokens from vaultB → initializerAtaB

3. **Cancellation Option**
   - If trade isn't completed, initializer or taker can cancel
   - Tokens in vaultA are returned to initializer
   - Tokens in vaultB are returned to taker

## Token Polling States

The TokenPollingService tracks negotiations through these states in the `PollingTask`:

type PollingTaskStatus = 'pending' | 'completed' | 'failed' | 'request_cancel' | 'cancelled';

### State Descriptions

1. **pending**
   - Initial state when escrow is created
   - TokenPollingService actively monitors vault balances
   - Waiting for deposits to meet expected thresholds
   - System checks balances periodically against expected amounts

2. **completed**
   - Both parties have successfully deposited required tokens
   - Exchange has executed successfully
   - System sends escrowCompleteTemplate notification

3. **failed**
   - Exchange couldn't complete successfully (i.e. Solana transaction failed)

4. **request_cancel**
   - Initializer has requested to cancel the escrow by editing the agent/escrow_data/polling-state.json file
   - Intermediate state while system verifies cancellation is possible
   - Checks if tokens haven't already been swapped
   - Prepares for cancellation process

5. **cancelled**
   - Cancellation has completed successfully
   - All tokens returned to original owners
## .env

The .env file contains the following variables:

```
WALLET_PRIVATE_KEY=   The private key for the agent's wallet
WALLET_PUBLIC_KEY=    The public key for the agent's wallet
RPC_URL=              The URL for the Solana RPC endpoint
```

## character.json

Your character.json file in agent/characters/ should additionally contain the following variables:
```json
"settings": {
  "wallet": {
    "max_retries": "The maximum number of retries for a fetch",
    "retry_delay": "The delay in milliseconds between retries"
  }
}
```
