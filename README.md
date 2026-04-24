# News Publisher

Automated distribution service that turns curated news cache items into X posts and Discord digests.

## Highlights

- Channel-based publisher interface for X and Discord delivery
- State, history, cache, and lock files for repeatable scheduled runs
- Built to consume the upstream news cache rather than scraping directly

## Tech Stack

- Node.js, modular publisher adapters, Docker Compose, HTTP integrations

## Repository Layout

- `scripts/news-publisher.mjs`
- `publishers`
- `package.json`
- `docker-compose.yml`

## Getting Started

- Copy `.env.local.example` to `.env.local` and set the target channels and credentials you need.
- Run `docker compose up --build` to execute the containerized publisher.
- Use `node scripts/news-publisher.mjs --dry-run` when you want preview output without posting.

## Current Status

- This README was refreshed from a code audit and is intentionally scoped to what is directly visible in the repository.
