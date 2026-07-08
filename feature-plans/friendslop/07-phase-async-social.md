# Phase 7: Async Social — Friends, Leaderboards & Base Showcase

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 7 of 8
> **Depends on:** `03-phase-backend-economy.md`, `05-phase-roguelite-loop.md`, `06-phase-asset-pipeline.md`
> **Estimated scope:** Medium

## Context from Previous Phase

The game is a complete, good-looking, server-authoritative single-player roguelite: combat, economy, gacha, upgrade trees, zones with validated loot, and real assets. What's missing is the "friends" hook that makes it *friendslop*. Per overview Decision #4, this is **async social** — no real-time shared world, no game server. It layers on top of the existing cloud-save backend.

**Relevant existing files:**
- `apps/server/src/services/economy/*`, `apps/server/src/repositories/*` — the authoritative data layer.
- `packages/shared/src/schema/*` — all data is already `player_id`-scoped (designed for this in Phase 3).
- `apps/server/src/services/hunt/reportHuntResult.ts` — where run outcomes (candidate leaderboard scores) resolve.
- `apps/web/src/ui/base/BaseScreen.tsx` — base state to snapshot for showcases.

## Objective

Add three async social features: a **friends graph** (add/accept), **server-validated leaderboards** (fastest zone clears / highest run scores), and **read-only base showcases** (view a friend's base facility layout). No real-time sync, no trading/gifting (deferred — RMT/loot-box risk per overview). The theme: compare and flex, not co-op.

## Architecture Decisions

### Decision: Leaderboard scores are server-derived, never client-submitted
- **Choice:** A leaderboard entry is written by the server inside `reportHuntResult` from the validated run outcome (bounded by the hunt seed from Phase 5). The client never submits a score.
- **Alternatives considered:** Client posts its time/score — rejected, trivially forged.
- **Rationale:** Same threat model as the economy — any client-authored number is untrusted. Phase 5's seed-bounding is what makes leaderboard scores trustworthy.
- **Tradeoff:** Only server-validatable metrics can be ranked; that's the point.

### Decision: Base showcase is a read-only server-rendered snapshot
- **Choice:** Viewing a friend's base fetches a server-authoritative snapshot of their `player_facilities` (levels/layout) and renders it read-only in the client. No mutation path touches another player's data.
- **Rationale:** ISP — expose only the fields needed to render a base; no write access, no economy exposure.
- **Tradeoff:** Not interactive; correct for MVP and safe.

## Implementation Steps

### Step 1: Friends schema + service
**What:** A friendship graph with request/accept.
**File(s):** `packages/shared/src/schema/social.ts`, `apps/server/src/services/social/friendService.ts`, `apps/server/src/repositories/friendRepo.ts`, actions `apps/server/src/app/actions/{sendFriendRequest,respondFriendRequest,listFriends}.ts`
**Details:**
- `friendships(id, requester_id, addressee_id, status ('pending'|'accepted'|'blocked'), created_at, unique(requester_id,addressee_id))`.
- Friend codes or display-name search to add. All reads scoped so you only see friends' public-safe data.
> **ANTI-PATTERN: Exposing Full Player Rows to Friends** — ❌ Don't return the whole `players`/wallet row to a friend. ✅ Return a minimal public profile projection (name, level, showcase). 💡 ISP + privacy; never leak economy internals.

### Step 2: Leaderboards (server-written)
**What:** Ranked boards fed by validated runs.
**File(s):** `packages/shared/src/schema/leaderboard.ts`, `apps/server/src/services/social/leaderboardService.ts`, extend `reportHuntResult.ts`, action `apps/server/src/app/actions/getLeaderboard.ts`
**Details:**
- `leaderboard_entries(id, board_id, player_id, score, metric, run_ref (hunt_session id), created_at)`; boards e.g. "Zone N fastest clear," "highest run score." Indexes on `(board_id, score)`.
- In `reportHuntResult`, after validating the run, upsert the player's best score for the relevant board **in the same transaction**.
- `getLeaderboard(boardId, scope: 'global'|'friends')` returns ranked entries; friends scope filters by the friendship graph.
> **ANTI-PATTERN: Client-Submitted Scores** — ❌ Don't accept `submitScore({ time })`. ✅ Server writes the score from the seed-validated run. 💡 Otherwise every board is instantly cheated.

### Step 3: Base showcase snapshot
**What:** Read-only view of a friend's base.
**File(s):** `apps/server/src/services/social/showcaseService.ts`, action `apps/server/src/app/actions/getBaseShowcase.ts`, `apps/web/src/ui/social/BaseShowcase.tsx`
**Details:** `getBaseShowcase(playerId)` — assert requester is a friend (or showcase is public) → return `player_facilities` levels + display name. Client renders the base read-only using the same base components in a non-interactive mode.

### Step 4: Social UI
**What:** Friends list, leaderboard screens, showcase viewer.
**File(s):** `apps/web/src/ui/social/{FriendsPanel,LeaderboardScreen}.tsx`, `apps/web/src/api/social.ts`
**Details:** Tailwind screens; reads via TanStack Query with sensible cache/invalidations. Friends scope toggle on leaderboards. Entry point from the main menu/HUD.

### Step 5: Rate limiting + abuse guards
**What:** Prevent friend-spam and leaderboard scraping.
**File(s):** `apps/server/src/lib/rateLimit.ts`, apply to social actions
**Details:** Per-user rate limits on friend requests and leaderboard queries; block/report path. Paginate all lists (never unbounded).
> **ANTI-PATTERN: Unbounded List Queries** — ❌ Don't `SELECT *` the whole leaderboard. ✅ Paginate with default + max limits, return total. 💡 One big board + one unbounded query = OOM.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Friendships | server data | `friendships` | **Server** | durable |
| Leaderboard entries | server data | `leaderboard_entries` (server-written) | **Server** | durable |
| Base showcase snapshot | server data | derived from `player_facilities` | Server | durable |
| Social UI lists | cache | TanStack Query | Server | refetched |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Friend request | Already friends / self | Inline validation message | Server rejects duplicate/self |
| View showcase | Not friends / private | "Not available" | Server authorization check |
| Leaderboard | Empty board | Friendly empty state | N/A |
| Any social read | Rate limit hit | "Slow down" toast | 429 + retry-after |

## Testing Requirements for This Phase

- [ ] A leaderboard score can only be written by the server from a validated run (no client submit path exists).
- [ ] Friend-scoped leaderboard returns only friends' entries.
- [ ] Base showcase rejects non-friends when private.
- [ ] Friend request lifecycle (send→accept) works and is idempotent-ish (no dup rows).
- [ ] Social lists are paginated; rate limits enforced.

**Test type guidance:** Integration-test authorization boundaries (can I read a non-friend's base? can I forge a score? — both must fail) and the `reportHuntResult`→leaderboard write. These are security tests as much as feature tests.

## Acceptance Criteria

- [ ] Players can add/accept friends.
- [ ] Global and friends-only leaderboards populate from real validated runs.
- [ ] No client path can submit or alter a leaderboard score.
- [ ] Players can view a friend's base read-only.
- [ ] No social endpoint leaks economy internals or allows cross-player mutation.

**Verification commands:**
- `pnpm --filter server test` — social authorization + leaderboard-write tests pass
- `pnpm --filter web build && pnpm --filter server build`

**Smoke test:** Add a second test account as a friend, do a fast zone clear, and see your time appear on the friends leaderboard; view your friend's base; confirm you cannot mutate it or read a stranger's private base.

## Handoff to Next Phase

Async social is live and secure: friends graph, server-validated leaderboards fed by seed-bounded runs, and read-only base showcases — all leak-free and cross-player-mutation-free. Trading/gifting remains deferred by design. The game is feature-complete for MVP. Phase 8 is the final gate: a performance/hardening pass and the **commercial launch checklist** — asset-license audit + regeneration, published-odds verification, region/age compliance, security review, and (only now) Stripe/payments integration.

**Open questions for next phase:**
- Whether public (non-friend) base showcases and global name search should be opt-in for privacy — recommended opt-in.
- Seasonal leaderboard resets — a post-launch feature, not MVP.
