---
title: "Product Brief: lokyy-brain"
status: "complete"
created: "2026-05-14"
updated: "2026-05-14"
inputs:
  - "CLAUDE_CODE_AUFTRAG.md"
  - "README.md"
  - "CLAUDE.md"
  - "docs/mockup/README.md"
  - "packages/shared/src/types.ts"
---

# Product Brief: lokyy-brain

## Executive Summary

Knowledge workers collect information all day long — articles, videos, meetings, ideas, decisions — but almost none of it compounds. It sits in disconnected silos, never linked, never revisited, never synthesized. The tools that exist either lock data behind a proprietary cloud (Obsidian Sync, Notion), lack any meaningful AI integration, or demand so much manual curation that the system collapses under its own weight.

lokyy-brain is a self-hosted Second Brain platform that changes this. It gives every knowledge worker a fully owned, Git-backed knowledge base accessible both from a human-facing PWA and from AI agents via the Model Context Protocol. Its defining capability is a Consolidation Agent — a scheduled process that runs while the user sleeps, autonomously discovering missing connections, creating topic notes, and enriching the vault, exactly the way a human brain consolidates information overnight. The result: a knowledge base that gets smarter without requiring constant manual effort.

Built for the post-MCP era, lokyy-brain is positioned as the foundational knowledge node of a personal AI operating system — a standard interface through which any AI agent can read, write, and reason about a user's accumulated knowledge.

## The Problem

Today's knowledge tools fail in three distinct ways:

**Data sovereignty is broken.** Obsidian's sync costs $96/year and stores data on Obsidian's servers. Notion, Roam, and Tana are SaaS-first, with your data held hostage. Privacy-conscious users and regulated industries cannot accept this model.

**AI integration is an afterthought.** Existing tools bolt on chat features or simple Q&A. None expose a standardized, scoped agent interface. Agents cannot write back into the vault, cannot be scoped to specific folders, and cannot collaborate with each other on the same knowledge base. The Model Context Protocol (MCP) changes what's possible — but no PKM tool was built with it in mind.

**Knowledge never actively compounds.** A Zettelkasten requires constant manual linking. A wiki rots without curation effort. The tools provide storage; they do not provide synthesis. Nobody has shipped a system that actively works on the knowledge base when the human is not there.

## The Solution

lokyy-brain is a three-component platform sharing a single core:

**1. The Vault.** Markdown files on disk, version-controlled by Git, with Forgejo as the remote source of truth. Every note has a stable ULID identifier, validated frontmatter, and belongs to a typed schema. The vault is the data — every index is derived and rebuildable from it. Data ownership is unconditional.

**2. The Human Interface (PWA).** A three-panel progressive web app: file tree, CodeMirror 6 live-preview editor (the same engine as Obsidian), and a live force-directed knowledge graph. An import pipeline (Pipes) captures YouTube transcripts, web pages, and voice memos directly into the vault. Works offline; syncs on reconnect.

**3. The Agent Interface (MCP Server).** A Model Context Protocol server exposing scoped tools: read notes, write notes, search semantically, traverse the graph, trigger imports. Each AI agent gets a defined scope (read/write globs, commit prefix for audit trail) configured from the vault itself. Multiple agents can operate simultaneously — personal assistant, company knowledge agent, domain specialists — each scoped to their relevant folders.

**The Consolidation Agent** ties it together: a scheduled process that examines notes changed since its last run, adds missing wikilinks between related notes, creates topic notes for recurring concepts, and writes discovered insights to a designated interventions folder. It operates through the same MCP interface as any other agent, subject to the same scoping and audit trail. The vault grows richer without user effort.

**Multi-Vault Architecture.** Users maintain a personal vault (private) and can participate in shared company vaults (with granular permissions). Both run on the same installation. This makes lokyy-brain viable for teams and small organizations, not just solo power users.

## What Makes This Different

| Dimension | lokyy-brain | Obsidian | SilverBullet | Logseq |
|-----------|------------|----------|--------------|--------|
| Data ownership | Full — Git on your server | Files local, sync proprietary | Files + server | Files local, DB version in progress |
| MCP-native | Yes — first-class | No | No | No |
| AI writes back | Yes (scoped) | No | No | No |
| Consolidation Agent | Yes | No | No | No |
| Team vaults | Yes (multi-vault) | Plugin-dependent | No | No |
| Setup wizard | Yes | N/A (local only) | Manual | N/A |

The defensible moat is not any single feature — it is the combination of Git-truth + MCP-native + autonomous consolidation. Each competitor can ship one of these; shipping all three coherently requires a ground-up architecture that none of them have.

## Who This Serves

**Primary: The Privacy-First Power User.** Developer, researcher, or knowledge worker who generates large volumes of information daily. Technically capable enough to self-host. Frustrated by Obsidian's sync pricing, Notion's data practices, or existing tools' inability to integrate meaningfully with AI agents. Values version history, plain Markdown, and unconditional data portability.

**Secondary: Small Teams and Knowledge-Driven Companies.** Organizations where 2–20 people need a shared knowledge base (company decisions, customer notes, project context) alongside personal vaults. The multi-vault architecture and MCP scoping make lokyy-brain the first self-hosted PKM tool that can serve both without compromising either.

**The AI Agent.** Any MCP-compatible AI system that needs structured access to a user's knowledge. lokyy-brain is not a human-only tool — it is designed to be a first-class citizen in multi-agent AI workflows.

## Success Criteria

**Personal baseline (v1):** Daily use by Oliver with zero friction. Vault ingests external content reliably via Pipes. Consolidation Agent runs nightly and produces useful wikilinks and topic notes.

**Community traction (12 months):** 500+ active self-hosted installations (defined as ≥1 vault commit in the past 30 days). Positive community signal on Hacker News, GitHub stars, and PKM communities. At least one third-party AI system integrating via MCP.

**Platform signal (24 months):** lokyy-brain cited as a reference MCP knowledge server implementation. Lokyy Cloud (managed hosted version) generating first revenue. Clear API for third-party vault plugins.

## Scope

**In for v1:**
- Setup Wizard (local and remote server installation, admin account creation, vault URL configuration)
- Auth/multi-user with personal vault per user + shared company vaults with role-based permissions (read/write/admin per vault)
- PWA: three-panel layout per mockup, CM6 live-preview editor, file tree, Pipes import (YouTube, web scrape); voice import as upload-only without transcription
- Memory Tier 1 (structural wikilink/tag index) + Tier 2 (semantic search via nomic-embed-text + pgvector)
- MCP Server with scoped tools, stdio transport, audit trail via commit prefix
- Consolidation Agent (scheduled, MCP-based, vault-enrichment) with review UI — accept/reject/ignore per intervention
- Core refactor: `packages/core` service layer, SPEC-valid frontmatter (ULID, schema validation)
- Offline PWA layer (IndexedDB cache + save queue)
- Stable wikilinks: ULID-based note identity ensures links never break on rename or folder reorganization

**Explicitly out of v1:**
- Tier 3 temporal knowledge graph (deferred pending real Tier 1+2 usage)
- SSO / LDAP / OAuth integration
- Native mobile apps (PWA covers mobile; iOS Web Share Target via Shortcuts fallback)
- Self-hosted Whisper transcription (voice files can be uploaded and stored; transcription deferred)
- Lokyy Cloud hosted offering (architecture planned, not built)
- Obsidian vault migration tooling (planned for v1.1 as primary acquisition lever)

## Why Now

MCP was standardized in November 2024. Google Cloud and Microsoft Azure have adopted it. The window to become the reference PKM implementation for the MCP ecosystem is open right now — and narrowing. Meanwhile, Obsidian's pricing backlash has created an active migration window among the power-user segment that lokyy-brain targets most directly. The enabling technology (local embedding models via Ollama, MCP SDKs, PWA offline APIs) is mature enough to build on without experimental risk. Six months from now, this combination of open market + ready technology + absent competition may not exist.

## Vision

In 2–3 years, lokyy-brain is a foundational knowledge node in personal and organizational AI operating systems. Every AI agent a user runs — personal assistant, coding agent, research agent, business automation — queries and contributes to a single unified knowledge base via MCP. The vault does not just store what the user knows; it actively integrates what every AI agent learns on the user's behalf. lokyy-brain is the memory layer for the agentic future.

Commercially: an open-source core (AGPL) drives trust, community adoption, and distribution. Lokyy Cloud — a managed hosted version with zero-ops setup — monetizes the segment that wants the capabilities without the infrastructure. Enterprise licensing covers regulated industries and team deployments requiring SLA and support.
