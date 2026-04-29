# Insighta Labs+ Backend

Secure Profile Intelligence Platform - Backend Service

## Overview

Insighta Labs+ is a secure, multi-interface profile intelligence platform that extends the original Profile Intelligence Service with authentication, role-based access control, and multiple client interfaces (CLI and Web Portal).

The backend service enriches names with demographic data (gender, age, country) by querying external APIs and stores results in a PostgreSQL database, while providing secure OAuth2 authentication via GitHub with PKCE.

## System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CLI Tool      │    │   Web Portal    │    │   Backend API   │
│   (insighta)    │────┤   (Next.js)     │────│   (Express)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
      ↓                      ↓                        ↓
  https://github.com/      https://github.com/      This repository
  chile4coding/            chile4coding/
  insighta-cli             insighta-web
```

### Components

- **Backend API** (this repo): Express.js REST API with JWT authentication
- **CLI Tool**: [`insighta-cli`](https://github.com/chile4coding/insighta-cli) - Command-line interface for power users
- **Web Portal**: [`insighta-web`](https://github.com/chile4coding/insighta-web) - Next.js web application for non-technical users

---

## Repository Links

| Component       | Repository                                                           | Description                                         |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| **Backend API** | [insighta-backend](https://github.com/chile4coding/insighta-backend) | Node.js + Express + TypeScript REST API (this repo) |
| **CLI Tool**    | [insighta-cli](https://github.com/chile4coding/insighta-cli)         | Global npm package for terminal access              |
| **Web Portal**  | [insighta-web](https://github.com/chile4coding/insighta-web)         | Next.js React application for browsers              |

All three repositories share the same authentication backend and database.

---

## Authentication Flow

### GitHub OAuth with PKCE

The system implements OAuth 2.0 with PKCE (Proof Key for Code Exchange) for secure authentication:

#### PKCE Flow

1. **Initiation**: Client generates `state` and `code_verifier`
2. **Challenge**: `code_challenge = SHA256(code_verifier)`
3. **Authorization**: Redirect to GitHub with `code_challenge` and `state`
4. **Callback**: GitHub returns authorization `code` and original `state`
5. **Validation**: Backend verifies `state` matches and sends `code_verifier`
6. **Token Exchange**: GitHub exchanges code for access token

#### Web Flow (Browser)

```
1. User clicks "Continue with GitHub"
   ↓
2. GET /api/auth/github
   → Generates PKCE state & code_verifier
   → Stores in encrypted session (PostgreSQL)
   → Redirects to GitHub OAuth page
   ↓
3. User authenticates on GitHub
   ↓
4. GitHub redirects to: /api/auth/github/callback?code=...&state=...
   ↓
5. Backend validates state from session
   ↓
6. Exchanges code + code_verifier for GitHub access token
   ↓
7. Creates/updates user in database
   ↓
8. Issues JWT tokens (access + refresh)
   ↓
9. Sets HTTP-only cookies:
   - access_token (3 min)
   - refresh_token (5 min)
   ↓
10. Redirects to frontend dashboard
```

#### CLI Flow (Command Line)

```
1. User runs: insighta login
   ↓
2. CLI generates PKCE state & code_verifier
   ↓
3. CLI starts local callback server (localhost:3000)
   ↓
4. CLI opens browser to GitHub OAuth
   ↓
5. User authenticates on GitHub
   ↓
6. GitHub redirects to: http://localhost:3000/callback?code=...&state=...
   ↓
7. CLI intercepts callback, validates state
   ↓
8. CLI sends POST /api/auth/refresh with:
   { code, state, code_verifier, x-cli-flow: true }
   ↓
9. Backend processes OAuth, returns tokens in JSON
   ↓
10. CLI stores tokens in ~/.insighta/credentials.json
    → Shows: "Logged in as @username"
```

### Token Management

| Token         | Expiry    | Storage                                             | Usage                                 |
| ------------- | --------- | --------------------------------------------------- | ------------------------------------- |
| Access Token  | 3 minutes | HTTP-only cookie (web) or local file (CLI)          | Authorization header for API requests |
| Refresh Token | 5 minutes | HttpOnly cookie (web) or encrypted local file (CLI) | Token rotation via POST /auth/refresh |

#### Token Rotation

Each call to `/auth/refresh`:

- Invalidates the old refresh token (deletes from database)
- Issues a new access + refresh token pair
- Sets new cookies (web) or returns new tokens (CLI)

#### Session Validation

Every authenticated request validates:

1. JWT signature and expiry
2. Token type is `access`
3. User exists and `isActive === true`
4. An unexpired refresh token exists in the database

If no valid session exists (logged out, expired, token rotated), access is denied even if the access token JWT hasn't technically expired.

### Token Structure (JWT Payload)

```typescript
{
  userId: string; // User's UUID from database
  role: string; // "admin" | "analyst"
  type: "access" | "refresh";
  iat: number; // Issued at
  exp: number; // Expiration timestamp
}
```

---

## User System

### User Model

| Field       | Type          | Notes                                   |
| ----------- | ------------- | --------------------------------------- |
| id          | UUID v7       | Primary key                             |
| githubId    | VARCHAR(255)  | Unique GitHub identifier                |
| username    | VARCHAR(255)  | GitHub login                            |
| email       | VARCHAR(255)  | Primary email                           |
| avatarUrl   | VARCHAR(500)? | GitHub avatar URL                       |
| role        | VARCHAR(20)   | `admin` or `analyst` (default: analyst) |
| isActive    | BOOLEAN       | If `false` → all requests return 403    |
| lastLoginAt | TIMESTAMP?    | Updated on each OAuth completion        |
| createdAt   | TIMESTAMP     | Account creation time                   |

### Default Role

All new users default to **`analyst`** (read-only). Admin privileges must be granted manually via database update:

```sql
UPDATE users SET role = 'admin' WHERE id = '...';
```

---

## Role-Based Access Control (RBAC)

### Roles

| Role      | Permissions                                        |
| --------- | -------------------------------------------------- |
| `admin`   | Full access: create, read, update, delete profiles |
| `analyst` | Read-only: list, get, search, export profiles      |

### Protected Endpoints

All `/api/*` endpoints require both authentication AND role enforcement.

| Endpoint               | Method | Required Role        |
| ---------------------- | ------ | -------------------- |
| `/api/profiles`        | POST   | `admin`              |
| `/api/profiles/:id`    | DELETE | `admin`              |
| `/api/profiles`        | GET    | `analyst` or `admin` |
| `/api/profiles/search` | GET    | `analyst` or `admin` |
| `/api/profiles/export` | GET    | `analyst` or `admin` |
| `/api/dashboard/stats` | GET    | `analyst` or `admin` |

### Middleware Enforcement

Two middleware layers protect all profile routes (`src/routes/profiles.ts`):

```typescript
router.use(authenticate); // 1. Verify JWT + active session
router.use(requireAnalystOrAdmin); // 2. Enforce role >= analyst
router.use(requireApiVersion); // 3. Require X-API-Version: 1 header
```

Individual routes can add stricter checks (e.g., `requireAdmin` for POST/DELETE).

---

## API Endpoints

### Base URL

```
Production: https://api.insightalabs.com
Development: http://localhost:4888
```

### Common Headers

**Required on all `/api/*` requests:**

```
X-API-Version: 1
```

**Authentication (choose one):**

Web (cookies):

```
Cookie: access_token=<jwt>; refresh_token=<jwt>
```

API/CLI (header):

```
Authorization: Bearer <access_token>
```

---

## Authentication Endpoints

### `GET /auth/github`

Initiates GitHub OAuth flow with PKCE.

**Response:** 302 Redirect to GitHub

---

### `GET /auth/github/callback`

GitHub OAuth callback handler.

**Query Parameters:**

- `code` - Authorization code from GitHub
- `state` - PKCE state parameter for CSRF protection

**Flow:**

1. Validates `state` matches stored session value
2. Checks PKCE timestamp (< 5 minutes old)
3. Exchanges code + `code_verifier` for GitHub access token
4. Fetches user profile and emails from GitHub
5. Creates or updates user in database
6. Issues JWT access + refresh tokens
7. Sets HTTP-only cookies (web) or returns JSON (CLI with `X-CLI-Flow: true` header)
8. Redirects to frontend (web) or returns tokens (CLI)

**Response (Web):**

```
HTTP/1.1 302 Found
Location: http://localhost:3000/dashboard
Set-Cookie: access_token=...; HttpOnly; SameSite=Strict
Set-Cookie: refresh_token=...; HttpOnly; SameSite=Strict
```

**Response (CLI):**

```json
{
  "status": "success",
  "data": {
    "access_token": "...",
    "refresh_token": "...",
    "user": {
      "id": "...",
      "username": "...",
      "email": "...",
      "avatarUrl": "...",
      "role": "analyst"
    }
  }
}
```

---

### `POST /auth/refresh`

Rotates access token using refresh token.

**Supports both:**

- JSON body: `{ "refresh_token": "string" }` (API/CLI)
- Cookie: `refresh_token` cookie (web auto-refresh)

**Response (Web):**

```json
{
  "status": "success",
  "message": "Tokens refreshed"
}
```

→ Sets new `access_token` and `refresh_token` cookies

**Response (API/CLI):**

```json
{
  "status": "success",
  "data": {
    "access_token": "...",
    "refresh_token": "..."
  }
}
```

**Security:** Old refresh token is immediately invalidated in database.

---

### `POST /auth/logout`

Revokes current session and clears tokens.

**Web Flow:**

- Clears `access_token` and `refresh_token` cookies
- Returns JSON with redirect URL:

```json
{
  "status": "success",
  "message": "Logged out successfully",
  "redirect": "http://localhost:3000/login?logout=success"
}
```

- Frontend should redirect user to `data.redirect`

**API/CLI Flow:**

```json
{
  "status": "success",
  "message": "Logged out successfully"
}
```

**Backend Actions:**

- Deletes refresh token from `sessions` table
- Clears cookies (web)
- Response format adapts to request type automatically

---

### `GET /auth/me`

Get current authenticated user info.

**Response:**

```json
{
  "status": "success",
  "data": {
    "id": "uuid",
    "githubId": "12345",
    "username": "johndoe",
    "email": "john@example.com",
    "avatarUrl": "https://github.com/...",
    "role": "analyst",
    "isActive": true,
    "lastLoginAt": "2026-04-28T03:00:00Z",
    "createdAt": "2026-04-20T00:00:00Z"
  }
}
```

---

## Profile Endpoints

All profile endpoints require header: `X-API-Version: 1`

### `GET /api/profiles`

List profiles with advanced filtering, sorting, and pagination.

**Query Parameters:**

| Parameter                 | Type                                            | Description                           |
| ------------------------- | ----------------------------------------------- | ------------------------------------- |
| `gender`                  | enum: `male`, `female`                          | Filter by gender                      |
| `age_group`               | enum: `child`, `teenager`, `adult`, `senior`    | Filter by age group                   |
| `country_id`              | ISO 2-letter code (e.g., `US`, `NG`)            | Filter by country                     |
| `min_age`                 | integer                                         | Minimum age (inclusive)               |
| `max_age`                 | integer                                         | Maximum age (inclusive)               |
| `min_gender_probability`  | float 0-1                                       | Minimum gender confidence             |
| `min_country_probability` | float 0-1                                       | Minimum country confidence            |
| `sort_by`                 | enum: `age`, `created_at`, `gender_probability` | Sort field                            |
| `order`                   | enum: `asc`, `desc`                             | Sort direction (default: `asc`)       |
| `page`                    | integer                                         | Page number (default: 1)              |
| `limit`                   | integer 1-50                                    | Items per page (default: 10, max: 50) |

**Response:**

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2500,
  "total_pages": 250,
  "links": {
    "self": "/api/profiles?page=1&limit=10&gender=male",
    "next": "/api/profiles?page=2&limit=10&gender=male",
    "prev": null
  },
  "data": [
    {
      "id": "uuid",
      "name": "john doe",
      "gender": "male",
      "age": 28,
      "age_group": "adult",
      "country_id": "US",
      "country_name": "United States",
      "gender_probability": 0.98,
      "country_probability": 0.95,
      "created_at": "2026-04-27T10:30:00.000Z"
    }
  ]
}
```

---

### `POST /api/profiles`

**Admin only.** Create a new profile by enriching a name.

**Request:**

```json
{
  "name": "Harriet Tubman"
}
```

**Process:**

1. Normalizes name (lowercase, trim)
2. Checks if profile already exists (idempotent)
3. Calls external APIs (Genderize, Agify, Nationalize) concurrently
4. Classifies age group automatically
5. Saves to database with `userId` of creator

**Response (201 Created):**

```json
{
  "status": "success",
  "data": {
    "id": "uuid-123",
    "name": "harriet tubman",
    "gender": "female",
    "gender_probability": 0.97,
    "age": 28,
    "age_group": "adult",
    "country_id": "US",
    "country_name": "United States",
    "country_probability": 0.89,
    "created_at": "2026-04-27T10:30:00.000Z"
  }
}
```

**Response (200 OK - already exists):**

```json
{
  "status": "success",
  "message": "Profile already exists",
  "data": { ...existing profile... }
}
```

---

### `GET /api/profiles/:id`

Get single profile by UUID.

**Response (200):**

```json
{
  "status": "success",
  "data": { ...profile object... }
}
```

**Response (404):**

```json
{
  "status": "error",
  "message": "Profile not found"
}
```

---

### `DELETE /api/profiles/:id`

**Admin only.** Delete a profile.

**Response (204 No Content)** - Empty body on success.

---

### `GET /api/profiles/search`

Natural language search using the internal query parser.

**Query Parameter:**

- `q` - Natural language query string (required)
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10, max: 50)

**Supported Query Patterns:**

| Query Example                    | Parsed As                                     |
| -------------------------------- | --------------------------------------------- |
| `"female adults from US"`        | gender=female, age_group=adult, country_id=US |
| `"males over 30"`                | gender=male, min_age=30                       |
| `"young people"`                 | age between 16-24                             |
| `"senior profiles from Germany"` | age_group=senior, country_id=DE               |

**Response:**
Same format as `GET /api/profiles` (with pagination links).

---

### `GET /api/profiles/export?format=csv`

Export profiles matching filters to CSV.

**Query Parameters:** Same as `GET /api/profiles` (filter, sort, limit applies)

**Response:**

```
HTTP/1.1 200 OK
Content-Type: text/csv
Content-Disposition: attachment; filename="profiles_2026-04-27_10-30-00.csv"

id,name,gender,gender_probability,age,age_group,country_id,country_name,country_probability,created_at
uuid-1,john doe,male,0.98,28,adult,US,United States,0.95,2026-04-27T10:30:00.000Z
...
```

**CSV Columns (exact order):**

1. `id`
2. `name` (quoted, escaped)
3. `gender`
4. `gender_probability`
5. `age`
6. `age_group`
7. `country_id`
8. `country_name` (quoted, escaped)
9. `country_probability`
10. `created_at` (ISO 8601)

**Delimiter:** Comma (`,`)

---

## Dashboard Endpoint

### `GET /api/dashboard/stats`

Get dashboard statistics (analytics).

**Authentication:** Required (analyst+)

**Response:**

```json
{
  "status": "success",
  "data": {
    "totalUsers": 150,
    "totalMale": 85,
    "totalFemale": 65,
    "totalChildren": 30,
    "recentProfiles": [
      {
        "id": "uuid-123",
        "name": "john doe",
        "gender": "male",
        "age": 28,
        "age_group": "adult",
        "country_id": "US",
        "country_name": "United States",
        "gender_probability": 0.98,
        "country_probability": 0.95,
        "created_at": "2026-04-27T10:30:00.000Z"
      }
    ]
  }
}
```

**Metrics:**

- `totalUsers` - Count of all registered users
- `totalMale` / `totalFemale` - Count of profiles by gender
- `totalChildren` - Count of profiles with `age_group = 'child'`
- `recentProfiles` - Up to 10 most recently created profiles (last 7 days), snake_case formatted

---

## Rate Limiting

Two-tier rate limiting by endpoint scope:

| Scope     | Limit              | Key                                | Exceeded Behavior     |
| --------- | ------------------ | ---------------------------------- | --------------------- |
| `/auth/*` | 10 requests/minute | IP address                         | 429 Too Many Requests |
| `/api/*`  | 60 requests/minute | User ID (or IP if unauthenticated) | 429 Too Many Requests |

**Rate Limit Headers (included in responses):**

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 59
X-RateLimit-Reset: 1714329600
```

**Configuration (`.env`):**

```env
RATE_LIMIT_WINDOW=60000    # 60 seconds
AUTH_RATE_LIMIT=10         # Auth endpoints
API_RATE_LIMIT=60          # All other endpoints
```

---

## Request Logging

All requests are logged to console with structured format:

```
[2026-04-28T03:39:02Z] GET /api/profiles 200 45ms
```

**Fields:**

- Timestamp (ISO 8601)
- HTTP method
- Endpoint path
- Status code
- Response time (ms)

Logs written via `requestLogger` middleware (`src/middleware/logger.ts`).

---

## Error Responses

Standardized JSON format for all errors:

```json
{
  "status": "error",
  "message": "Human-readable error message"
}
```

### HTTP Status Codes

| Code | Meaning               | Example                                                 |
| ---- | --------------------- | ------------------------------------------------------- |
| 400  | Bad Request           | Missing `X-API-Version` header, invalid query params    |
| 401  | Unauthorized          | No token provided                                       |
| 403  | Forbidden             | Valid token but insufficient permissions, user inactive |
| 404  | Not Found             | Profile not found                                       |
| 422  | Validation Error      | Invalid email, malformed request body                   |
| 429  | Rate Limit Exceeded   | Too many requests                                       |
| 502  | External API Error    | Genderify/Agify/Nationalize service down                |
| 500  | Internal Server Error | Unexpected server error                                 |

---

## Environment Variables

Create `.env` file from `.env.example`:

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/insighta_labs?schema=public

# Server
PORT=4888

# JWT Secrets
JWT_SECRET=your-256-bit-secret-change-this-in-production
ACCESS_TOKEN_EXPIRES=180    # 3 minutes
REFRESH_TOKEN_EXPIRES=300   # 5 minutes

# GitHub OAuth (create app at https://github.com/settings/developers)
CLIENT_ID=your_client_id
CLIENT_SECRET=your_client_secret
CALLBACK_URL=http://localhost:4888/api/auth/github/callback

# Frontend URL (for redirects)
FRONTEND_URL=http://localhost:3000

# Session (for PKCE state storage)
SESSION_SECRET=your-session-secret-change-this-in-production

# Rate Limiting
RATE_LIMIT_WINDOW=60000
AUTH_RATE_LIMIT=10
API_RATE_LIMIT=60

# Deployment (for GitHub Actions - optional locally)
SERVER_IP=your-server-ip
SERVER_PORT=22
SERVER_USER=your-username
SERVER_PASSWORD=your-password
SERVER_PATH=/path/to/deploy
```

**⚠️ Security Notes:**

- Never commit `.env` to version control
- Use strong, randomly generated secrets in production
- Set `NODE_ENV=production` in production (enables HTTPS cookies, stricter security)

---

## Database Schema

### Prisma Models

**User** (`prisma/schema.prisma`):

```prisma
model User {
  id             String    @id @default(uuid(7))
  githubId       String    @unique @map("id")
  username       String
  email          String
  avatarUrl      String?   @map("avatar_url")
  role           String    @default("analyst")
  isActive       Boolean   @default(true) @map("is_active")
  lastLoginAt    DateTime? @map("last_login_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  profiles       Profile[]
  sessions       Session[]
}
```

**Session** (JWT refresh tokens):

```prisma
model Session {
  id           String   @id @default(uuid(7))
  userId       String   @map("user_id")
  refreshToken String   @unique @map("refresh_token")
  expiresAt    DateTime @map("expires_at")
  createdAt    DateTime @default(now()) @map("created_at")
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Profile** (enriched data):

```prisma
model Profile {
  id                 String   @id @default(uuid(7))
  name               String   @unique
  gender             String?
  genderProbability  Float?   @map("gender_probability")
  age                Int?
  ageGroup           String?  @map("age_group")
  countryId          String?  @map("country_id")
  countryName        String?  @map("country_name")
  countryProbability Float?   @map("country_probability")
  createdAt          DateTime @default(now()) @map("created_at")
  userId             String?  @map("user_id")
  user               User?    @relation(fields: [userId], references: [id])
}
```

**WebSession** (express-session table):

```prisma
model WebSession {
  sid    String   @id @map("sid")
  sess   String   @map("sess")
  expire DateTime @map("expire")
}
```

---

## Setup & Installation

### Prerequisites

- Node.js v20+
- PostgreSQL database (v15+)
- GitHub OAuth App credentials
- (Optional) PM2 for process management in production

### Local Development

```bash
# Clone & install
npm install

# Generate Prisma client
npm run prisma:generate

# Run migrations (creates tables)
npm run prisma:migrate

# Seed with sample data (optional)
npm run seed

# Start development server (with hot reload)
npm run dev
# Server runs at http://localhost:4888
```

### Build for Production

```bash
# Compile TypeScript and copy seed data
npm run build

# Output: dist/server.js + all compiled files
```

### Production Deployment

```bash
# Install production dependencies only
npm ci --only=production

# Generate Prisma client
npx prisma generate

# Apply migrations
npx prisma migrate deploy

# Start server
npm start
```

---

## GitHub Actions CI/CD

### Workflow: `.github/workflows/deploy.yml`

Triggers: Push to `main`

**Steps:**

1. Checkout code
2. Setup Node.js 20
3. Install dependencies (`npm ci`)
4. Generate Prisma client
5. Run migrations (`npx prisma migrate deploy`)
6. Build TypeScript
7. Copy files to server (`dist/`, `prisma/`, `package.json`, `.env.example`)
8. Create `.env` on server from GitHub Secrets
9. Install production dependencies on server
10. Prisma generate & migrate on server
11. Restart with PM2 (`insighta-backend` process)
12. Verify `/health` endpoint returns 200

**Path:** `.github/workflows/deploy.yml`

---

## Natural Language Query Parser

The system supports intuitive search queries without requiring users to know exact filters.

### Parser Implementation

**File:** `src/services/queryParser.ts`

Parses phrases like:

| Input                         | Parsed Filters                                               |
| ----------------------------- | ------------------------------------------------------------ |
| `"female adults from US"`     | `{ gender: "female", age_group: "adult", country_id: "US" }` |
| `"males over 30"`             | `{ gender: "male", min_age: 31 }`                            |
| `"young people from Nigeria"` | `{ min_age: 16, max_age: 24, country_id: "NG" }`             |
| `"senior females"`            | `{ age_group: "senior", gender: "female" }`                  |

### How It Works

1. Tokenize query into words
2. Match keywords to known filters:
   - Gender keywords: `male`, `female`, `man`, `woman`, `boy`, `girl`
   - Age keywords: `young` (16-24), `adult` (25-59), `senior` (60+), `child` (0-17), `teen` (13-19)
   - Comparators: `over 30` → `min_age: 30`, `under 18` → `max_age: 17`
   - Country: Any ISO country name/abbreviation (`USA`, `America` → `US`)
3. Build structured `ProfileQueryParams` object
4. Merge with explicit query params (from URL)
5. Pass to `buildWhereClause()` for Prisma query

### Extending Parser

Add new patterns to `parseNaturalLanguageQuery()` in `src/services/queryParser.ts` - it's a simple rule-based system with no ML dependencies.

---

## Security Best Practices

### Implemented

1. **OAuth 2.0 with PKCE** - Prevents authorization code interception attacks
2. **HTTP-only cookies** - JavaScript cannot access tokens (XSS protection)
3. **SameSite=Strict** - CSRF protection for cross-site requests
4. **Token rotation** - Each refresh invalidates old token
5. **Session revocation** - Logout deletes refresh token from DB immediately
6. **JWT expiry** - Short-lived access tokens (3 min), refresh tokens (5 min)
7. **Rate limiting** - Auth endpoints (10/min), API (60/min)
8. **Input validation** - All query params validated by `parseQueryParams()`
9. **SQL injection prevention** - Prisma ORM parameterized queries
10. **Secrets management** - All secrets via environment variables only
11. **User deactivation** - `isActive=false` prevents all access
12. **Session validation** - Every request checks for unexpired refresh token in DB

### Production Checklist

- [ ] Use HTTPS only (set `NODE_ENV=production` → secure cookies)
- [ ] Set strong `JWT_SECRET` and `SESSION_SECRET` (256-bit random)
- [ ] Configure firewall to allow only necessary ports
- [ ] Enable database SSL/TLS if applicable
- [ ] Rotate secrets periodically
- [ ] Monitor rate limit violations
- [ ] Set up log aggregation (e.g., Winston + CloudWatch)
- [ ] Enable database connection pooling
- [ ] Use process manager (PM2) with `--max-restarts`

---

## CLI Tool Specification

### Installation

```bash
# From CLI repository (separate)
npm install -g @insighta/cli

# Verify
insighta --version
```

### Commands

#### `insighta login`

Starts OAuth flow:

```
$ insighta login
✓ Opening browser...
✓ Waiting for authorization...
✓ Logged in as @johndoe
```

Stores credentials in `~/.insighta/credentials.json` (encrypted with OS keychain where available).

#### `insighta logout`

Revokes session and deletes local credentials.

#### `insighta whoami`

Shows current user:

```
$ insighta whoami
@johndoe (admin)
Last login: 2026-04-28T03:00:00Z
```

#### `insighta profiles list`

List profiles with filters (same as API query params).

**Examples:**

```bash
# List all
insighta profiles list

# Filter by gender
insighta profiles list --gender male

# Multiple filters
insighta profiles list --country US --age-group adult --min-age 25 --max-age 40

# Pagination
insighta profiles list --page 2 --limit 20

# Sorting
insighta profiles list --sort-by created_at --order desc
```

**Output:** Rich table (box-drawing chars) with columns:

```
ID                                    Name          Gender  Age  Country  Created At
uuid-123                              John Doe      male    28   US       2026-04-27
```

#### `insighta profiles get <id>`

Get single profile by UUID.

#### `insighta profiles search "<query>"`

Natural language search.

```bash
insighta profiles search "female adults from US"
```

#### `insighta profiles create --name "John Doe"`

Create new profile (admin only).

#### `insighta profiles export --format csv [filters]`

Export to CSV. Saves to `./profiles_<timestamp>.csv` in current directory.

---

## Web Portal Requirements

### Pages

1. **Login Page** (`/login`)
   - "Continue with GitHub" button
   - Handles `?logout=success` query param
   - Shows error messages if login fails

2. **Dashboard** (`/dashboard`)
   - Stats cards: total users, male/female counts, children count
   - Table of recent profiles (last 7 days)
   - Quick links to create/search

3. **Profiles List** (`/profiles`)
   - Filter sidebar (gender, age group, country)
   - Sortable table headers
   - Pagination controls
   - Export CSV button

4. **Profile Detail** (`/profiles/:id`)
   - Full profile information
   - Back to list link

5. **Search** (`/search`)
   - Natural language search bar
   - Results table

6. **Account** (`/account`)
   - Current user info
   - Logout button

### Authentication

- **HTTP-only cookies** - `access_token`, `refresh_token`
- **CSRF protection** - `SameSite=Strict` + CSRF token in custom header
- **Protected routes** - Redirect to `/login` if not authenticated
- **Auto-refresh** - Silent token refresh before expiry (3 min)

---

## Testing Strategy

### Currently Implemented

- **Manual testing** via curl/Postman/Insomnia
- **Type checking** (`npm run typecheck`)
- **Linting** (`npm run lint`)

### Test Coverage Areas

1. **Authentication flows** (PKCE validation, token issuance, refresh, logout)
2. **RBAC enforcement** (analyst vs admin permissions)
3. **Profile CRUD** (create, read, update, delete, search, export)
4. **Rate limiting** (throttling per endpoint)
5. **Query parsing** (natural language edge cases)
6. **Error handling** (all standard HTTP codes)
7. **Session management** (token rotation, revocation, expiry)

### Future Work

- Add Jest test suite (`tests/` directory)
- Integration tests with test database
- E2E tests with Supertest

---

## Known Limitations & Future Improvements

1. **Test Coverage** - No automated tests yet (pending Jest setup)
2. **Redis** - Not used; session store is PostgreSQL (suitable for <10k users)
3. **Email Notifications** - None (user creation, security alerts)
4. **Audit Logging** - No audit trail of user actions
5. **Password Reset** - OAuth-only (GitHub), no password flow
6. **Multi-factor Auth** - Not implemented
7. **Session Limits** - Users can have unlimited concurrent sessions
8. **API Rate Limits** - Per-user, not per-resource-type
9. **Error Details** - Generic error messages (no stack traces in production)
10. **Request ID Tracing** - No distributed tracing for debugging

---

## Contributing

### Commit Standards

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

Types:
- feat: new feature
- fix: bug fix
- docs: documentation
- style: formatting (no code change)
- refactor: code restructuring
- test: adding tests
- chore: maintenance

Examples:
feat(auth): add GitHub OAuth with PKCE
fix(profiles): handle null gender in aggregation
docs: update API usage examples
```

### Branch Naming

```
main              → production-ready
feature/xyz       → new feature
fix/xyz           → bug fix
hotfix/xyz        → urgent production fix
release/v1.0.0    → release preparation
```

### Pull Requests

1. Create feature branch from `main`
2. Make changes with clear, atomic commits
3. Push and open PR to `main`
4. Include description of changes and testing steps
5. Request review from team member
6. Merge after approval + CI passes

---

## License

MIT

## Support

For issues and questions, please refer to the main project repository.
