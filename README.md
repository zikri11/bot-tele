# Telegram Bot - Automation & Broadcast Manager

A robust, modular Telegram Bot and MTProto Userbot system built with TypeScript, grammY, and PostgreSQL.

## Features
- **Dual-Bot Architecture:** Decoupled main interactive controller and notification worker.
- **Resilient Rate-Limiting:** Automatic retry handling (`@grammyjs/auto-retry`) and time-based UI throttling.
- **Defensive Error Handling:** Automatic notification muting on user block (HTTP 403) and failure isolation.
- **MTProto Userbot Engine:** GramJS multi-account session management, official device spoofing, and dynamic human jitter delays.
- **Group Management:** Automated group scanning, custom broadcast list creation, and bulk join tools.
- **License & Subscription:** Built-in redeem code generator and duration tracking with PostgreSQL and Drizzle ORM.

## Tech Stack
- **Language:** TypeScript / Node.js
- **Bot Framework:** grammY
- **MTProto Client:** GramJS (`telegram`)
- **Database & ORM:** PostgreSQL + Drizzle ORM
- **Runtime:** tsx / Node.js

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database
- Telegram API ID & Hash from [my.telegram.org](https://my.telegram.org)
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/zikri11/bot-tele.git
   cd bot-tele
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup environment variables:
   ```bash
   cp .env.example .env
   # Configure your variables in .env
   ```

4. Run database migrations:
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

5. Start the bot:
   ```bash
   # Development
   npm run dev

   # Production Build
   npm run build
   npm start
   ```

## License
MIT
