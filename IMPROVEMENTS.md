# Username Availability Search — System Improvements

## Executive Summary

The current implementation (Flow 1) is solid: Redis cache-first, PostgreSQL as source of truth, atomic `SET NX` reservation with TTL, and a UNIQUE constraint. Below are targeted improvements to enhance scalability, user experience, and operational resilience.

---

## 1. Bloom Filter Pre-Filter

**Problem:** Even a Redis `GET` (sub-ms) adds latency. For high-traffic scenarios, we can reduce Redis/database load with a probabilistic pre-filter.

**Solution:** Use a Redis Bloom Filter (via RedisBloom module) to quickly reject taken usernames. Bloom filters have false positives but zero false negatives — a "maybe taken" result still proceeds to Redis/DB, but a "definitely free" short-circuits the pipeline.

**Trade-off:** Adds Redis module dependency. False positives cause some lookups to proceed farther than necessary, but throughput increases.

**Implementation:**
```ts
// Before Redis GET, check Bloom filter
const bfResult = await redis.bfExists("usernames:bloom", username);
if (bfResult === 0) {
  // Definitely not in filter → never seen before → available
  return reserveAndReturnSuccess();
}
// Otherwise continue to Redis lookup
```

---

## 2. Case-Insensitive Username Strategy

**Problem:** Current validation is case-sensitive ("John" ≠ "john"). Users expect case-insensitive uniqueness, but the DB stores the chosen casing.

**Solution:**
- Add a normalized `username_lower` column with a UNIQUE index.
- Store `LOWER(username)` on write.
- Query using `LOWER(:username)` to check availability.

**Benefit:** Users can't squat "John" while "john" remains available. Prevents confusion and brand impersonation.

---

## 3. Prefix Search API

**Problem:** Users typing a username get only binary (available/taken) feedback. UX suffers when the desired name is taken but alternatives exist.

**Solution:** Add `GET /username/suggestions?prefix=john&limit=10` that returns similar available usernames:

- **Exact match** → unavailable
- **Fuzzy suggestions** → `johnny`, `john-doe`, `john_doe`, `john1` using:
  - Simple suffix additions (`-dev`, `_123`)
  - Levenshtein distance or Metaphone phonetics for near-misses
  - Thesaurus-based word substitutions if semantically relevant

**Benefit:** Reduces user abandonment, improves sign-up conversion.

---

## 4. Reservation Renewal (Keep-Alive)

**Problem:** 10-minute TTL may expire while the user is still filling out a long form (e.g., mobile data drop, multi-step verification). Forced re-check causes frustration.

**Solution:** Allow the client to refresh the reservation before expiry:
```
POST /username/renew
{ "reservationId": "...", "username": "..." }
```
Server verifies ownership and extends TTL by another 10 minutes.

**Benefit:** Robust UX for slow networks or interrupted sessions.

---

## 5. Rate Limiting per Username (Back-Off)

**Problem:** A malicious user can hammer the same username with concurrent requests to block legitimate users (denial-of-reservation attack).

**Solution:** Add per-username rate limiting in Redis:
```
RPUSH username:rate:{username} <timestamp>
EXPIRE 60
LEN → if > 5 attempts in 60s → 429 Too Many Requests
```
Enforces gentle back-off even across IP changes.

**Benefit:** Prevents reservation hoarding and squatting.

---

## 6. Global Username Deny List (Regex Patterns)

**Problem:** Reserved words list is static. Bad actors can bypass with slight variations (e.g., "adm1n", "ad min").

**Solution:** Maintain a regex-based deny list stored in Redis/config:
- Block common impersonations (`^admin.*`, `.*support.*`, `^security.*`)
- Block trademarked terms
- Use a trie/automaton for efficient matching

**Benefit:** Hardens against brand abuse and impersonation.

---

## 7. Distributed Lock (Redlock) for DB Write Path

**Problem:** The atomic `SET NX` handles Redis-side races, but between Step 3 (DB check) and Step 4 (SET) there's a tiny window where a concurrent publish (Flow 2) could insert the user, making our subsequent `SET` succeed incorrectly.

**Solution:** Wrap the critical section in a distributed lock:
```
LOCK username:publish:{username} TTL 500ms
  → Check DB again inside the lock
  → Attempt INSERT (unique constraint still the final guard)
  → Release lock
```
We already have the UNIQUE constraint, but Redlock eliminates wasted DB work and provides deterministic conflict resolution.

**Benefit:** Cleaner concurrency, predictable outcomes.

---

## 8. Hotspot Caching (Top-N Usernames)

**Problem:** Common names like "john", "alex", "mike" are checked thousands of times per day. Each hits Redis and sometimes DB.

**Solution:** Pre-populate Redis with a longer TTL (24h) for high-frequency usernames. Use a background job to refresh periodically.

**Benefit:** Reduces DB load for the 80/20 hot set.

---

## 9. Asynchronous Reservation Cleanup

**Problem:** Expired Redis keys clean themselves via TTL, but we have no visibility into active reservations.

**Solution:** Schedule a periodic Redis scan (e.g., every 5 min) to:
- Count keys matching `username:reserve:*`
- Emit metrics: `reservations.active`, `reservations.expired`
- Optionally log suspicious patterns (same IP reserving many names)

**Benefit:** Operational observability and abuse detection.

---

## 10. Phonetic & Soundex Matching for Suggestions

**Problem:** When a username is taken, suggestions are mechanical. Users may want phonetically similar names.

**Solution:** Store a Soundex/Metaphone hash alongside the username in a Redis Set:
```
SADD username:soundex:D520 "john-doe"
SADD username:soundex:A230 "adams"
```
Query by phonetic code to propose alternatives that sound similar.

**Benefit:** More creative, human-like suggestions.

---

## 11. Cache Warming on Startup

**Problem:** After a Redis restart, all reservations are lost until users re-check names, potentially causing double-booking until DB writes re-populate cache.

**Solution:** On application boot, scan the `users` table and pre-populate Redis with a short-lived placeholder (TTL 60s) for every active username:
```
SET username:reserve:{username} "warm" EX 60
```
This prevents a thundering herd of concurrent checks for popular names right after cache loss.

**Benefit:** Smooth restart behaviour, fewer race conditions.

---

## 12. Request Batching (Multi-Check API)

**Problem:** Frontends may pre-validate multiple usernames in parallel (e.g., "john", "johnny", "john-doe"). Naive approach triggers N requests.

**Solution:** Add `POST /username/check-batch` accepting an array:
```json
{ "usernames": ["john", "johnny", "john-doe"] }
```
Server processes them in a single DB round-trip:
```sql
SELECT username FROM users WHERE username IN ($1, $2, $3)
```
Returns per-item availability.

**Benefit:** Fewer connections, lower latency for bulk checks.

---

## 13. Logging + Request Tracing

**Problem:** Debugging a failed reservation is hard without context.

**Solution:** Include a `X-Request-ID` header returned on every response. Log:
- Timestamp, IP, username
- Cache hit/miss, DB round-trip time, total latency
- Reservation decision (awarded/lost race)

Store logs in structured JSON for ELK/Datadog ingestion.

**Benefit:** Audit trail, faster troubleshooting, abuse pattern detection.

---

## 14. Upstream CDN/Edge Caching

**Problem:** A single global Redis is a bottleneck for global scale.

**Solution:** Cache negative results (definitely available) at the edge (Cloudflare Workers, Fastly) for 1 second. Strategic short TTL prevents most cache misses from hitting origin.
- Edge checks local cache first
- Miss → origin (`/username/check`) → cache result at edge

**Benefit:** Reduces origin QPS, lowers p50/p99 latency worldwide.

---

## 15. Username Normalization Rules (Unicode NFKC)

**Problem:** Unicode homoglyphs can create visual duplicates: "Jöhn" vs "John". Different code points may render similarly.

**Solution:** Normalize all usernames to Unicode NFKC form before validation/storage. Reject names containing non-ASCII outside an allowlist.

**Benefit:** Prevents visually confusing usernames, improves security against homograph attacks.

---

## 16. Background Indexing for Search

**Problem:** Future UX may include username autocomplete/search. Scanning `users` table repeatedly is expensive.

**Solution:** Use Redis Search (RediSearch) or Elasticsearch to maintain an indexed, searchable username store that stays in sync via database triggers or application events.

**Benefit:** Sub-ms prefix/suffix/fuzzy search at scale.

---

## 17. Dead-letter Reservation Queue

**Problem:** If the reservation process fails after DB check but before Redis set (e.g., Redis timeout), the user is stuck — DB says free but they can't reserve.

**Solution:** Use a persistent queue (BullMQ) to record failed reservation attempts. A retry worker re-attempts the Redis `SET NX` with a back-off.

**Benefit:** Improves reliability in flaky Redis scenarios.

---

## 18. Circuit Breaker for Redis

**Problem:** Redis outage degrades latency (all requests fall through to DB) or fails outright.

**Solution:** Wrap Redis calls with a circuit breaker (e.g., `opossum`). If Redis fails repeatedly, temporarily bypass caching and go straight to DB (with higher rate limits). When Redis recovers, melt back in.

**Benefit:** Graceful degradation under partial infrastructure failure.

---

## 19. WebSocket Reservation Stream

**Problem:** Long-polling or manual refresh for reservation status is clunky.

**Solution:** For advanced UIs, expose a WebSocket endpoint that pushes reservation expiry warnings 1 minute before TTL ends, allowing the client to auto-renew.

**Benefit:** Better UX for real-time interactive flows.

---

## 20. Schema Evolution: Separate `reservations` Table

**Problem:** All reservation state lives in Redis, which is volatile. For audit/compliance we may need a persistent reservation log.

**Solution:** Add a `reservations` table with columns: `id`, `username`, `user_id` (nullable), `expires_at`, `created_at`. Insert on successful reservation; delete on publish. Allows historical analysis and recovery from Redis loss.

**Benefit:** Auditability, analytics on reservation success rates.

---

## Prioritization Roadmap

| Priority | Improvement | Effort | Impact |
|----------|-------------|--------|--------|
| **P0** | **Case-insensitive usernames** (`username_lower`) | Low | High |
| **P0** | **Per-username rate limiting** | Low | High |
| **P1** | **Reservation renewal endpoint** | Low | Medium |
| **P1** | **Batch check API** (`/check-batch`) | Low | Medium |
| **P1** | **Circuit breaker for Redis** | Low | Medium |
| **P2** | **Bloom filter pre-filter** | Medium | Medium |
| **P2** | **Prefix suggestion API** | Medium | Medium |
| **P2** | **Unicode normalization (NFKC)** | Low | High |
| **P3** | **Hotspot cache warming** | Low | Low |
| **P3** | **Request tracing (`X-Request-ID`)** | Low | Low |
| **P4** | **Phonetic suggestions** | High | Low |
| **P4** | **Dead-letter reservation queue** | Medium | Low |
| **P5** | **Edge caching (CDN)** | High | Medium |
| **P5** | **Persistent reservations table** | Medium | Low |
| **P5** | **WebSocket renewal stream** | High | Low |
| **P6** | **Global deny list (regex)** | Medium | Medium |

---

## Notes

- All improvements are **backward-compatible**; none require breaking the existing `/username/check` contract.
- Some require Redis modules (Bloom filter) or external services (CDN). Evaluate based on scale needs.
- The UNIQUE constraint in PostgreSQL remains the ultimate source of truth regardless of optimizations.
