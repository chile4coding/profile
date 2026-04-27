# Insighta Labs+ Backend

Secure Profile Intelligence Platform - Backend Service

## Overview

Insighta Labs+ is a secure, multi-interface profile intelligence platform that extends the original Profile Intelligence Service with authentication, role-based access control, and multiple client interfaces (CLI && Web Portal).

The backend service enriches names with demographic data (gender, age, country) by querying external APIs and stores results in a PostgreSQL database, while providing secure OAuth2 authentication via GitHub with PKCE.

## System Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CLI Tool      │    │   Web Portal    │    │   Backend API   │
│   (insighta)    │────┤   (Next.js)     │────│   (Express)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                │
                                         ┌──────┴──────┐
                                         │  PostgreSQL│
                                         │  Database  │
                                         └────────────┘
```

### Components

- **Backend API** (this repo): Express.js REST API with JWT authentication
- **CLI Tool**: Command-line interface for power users
- **Web Portal**: Next.js web application for non-technical users

## Authentication Flow

### GitHub OAuth with PKCE

The system implements OAuth 2.0 with PKCE (Proof Key for Code Exchange) for secure authentication:

**CLI Flow:**

1. User runs `insighta login`
2. CLI generates PKCE code_verifier and code_challenge
3. CLI starts local callback server (port 3000)
4. CLI opens GitHub OAuth in browser
5. GitHub redirects to local callback with authorization code
6. CLI exchanges code + code_verifier for JWT tokens
7. Tokens stored securely in `~/.insighta/credentials.json`

**Web Flow:**

1. User clicks "Continue with GitHub"
2. Browser redirects to GitHub OAuth
3. GitHub redirects back with authorization code
4. Backend exchanges code for JWT tokens
5. Tokens set in HTTP-only cookies (secure, SameSite=Strict)

### Token Management

- **Access Token**: 3-minute expiry (JWT)
- **Refresh Token**: 5-minute expiry (JWT, stored in database)
- **Token Rotation**: Each refresh invalidates the old refresh token
- **Revocation**: Logout immediately invalidates refresh tokens

### Token Structure

```typescript
{
  userId: string; // User's UUID
  role: string; // "admin" | "analyst"
  type: "access" | "refresh";
}
```

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: PostgreSQL (Prisma ORM)
- **Language**: TypeScript
- **Authentication**: JWT, OAuth2 PKCE
- **Security**: Express-rate-limit, cookie-parser, CSRF protection

## Database Schema

### User Model

```prisma
model User {
  id             String   @id @default(uuid(7))
  githubId       String   @unique
  username       String
  email          String
  avatarUrl      String?
  role           String   @default("analyst")  // admin | analyst
  isActive       Boolean  @default(true)
  lastLoginAt    DateTime?
  createdAt      DateTime @default(now())
  profiles       Profile[]
  sessions       Session[]
}
```

### Session Model

```prisma
model Session {
  id           String   @id @default(uuid(7))
  userId       String
  refreshToken String   @unique
  expiresAt    DateTime
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id])
}
```

### Profile Model

```prisma
model Profile {
  id                 String   @id @default(uuid(7))
  name               String   @unique
  gender             String?
  genderProbability  Float?
  age                Int?
  ageGroup           String?
  countryId          String?
  countryName        String?
  countryProbability Float?
  createdAt          DateTime @default(now())
  userId             String?  // Profile creator
  user               User?    @relation(fields: [userId], references: [id])
}
```

## Role-Based Access Control (RBAC)

### Roles

- **Admin**: Full access - create, read, update, delete profiles
- **Analyst**: Read-only - can only view and search profiles

### Protected Endpoints

All `/api/*` endpoints require authentication and enforce role permissions:

| Endpoint               | Method | Required Role |
| ---------------------- | ------ | ------------- |
| `/api/profiles`        | POST   | admin         |
| `/api/profiles/:id`    | DELETE | admin         |
| `/api/profiles`        | GET    | analyst+      |
| `/api/profiles/search` | GET    | analyst+      |
| `/api/profiles/export` | GET    | analyst+      |
| `/api/auth/*`          | -      | varies        |

## API Endpoints

### Authentication

#### `GET /auth/github`

Redirect to GitHub OAuth authorization page.

#### `GET /auth/github/callback`

Handle GitHub OAuth callback, create user, issue tokens.

#### `POST /auth/refresh`

**Request:** `{ "refresh_token": "string" }`

**Response:**

```json
{
  "status": "success",
  "access_token": "string",
  "refresh_token": "string"
}
```

#### `POST /auth/logout`

Invalidate refresh token and clear session.

#### `GET /auth/me`

Get current user info (protected).

### Profile Endpoints

All profile endpoints require `X-API-Version: 1` header.

#### `GET /api/profiles`

List profiles with filtering, sorting, pagination.

**Query Parameters:**

- Filtering: `gender`, `country_id`, `age_group`, `min_age`, `max_age`, `min_gender_probability`, `min_country_probability`
- Sorting: `sort_by` (age, created_at, gender_probability), `order` (asc, desc)
- Pagination: `page`, `limit` (max 50)

**Response:**

```json
{
  "status": "success",
  "page": 1,
  "limit": 10,
  "total": 2026,
  "total_pages": 203,
  "links": {
    "self": "/api/profiles?page=1&limit=10",
    "next": "/api/profiles?page=2&limit=10",
    "prev": null
  },
  "data": [...]
}
```

#### `POST /api/profiles`

**Admin only.** Create new profile.

**Request:**

```json
{ "name": "Harriet Tubman" }
```

**Response:**

```json
{
  "status": "success",
  "data": { "id": "...", "name": "harriet tubman", ... }
}
```

#### `GET /api/profiles/:id`

Get profile by ID.

#### `DELETE /api/profiles/:id`

**Admin only.** Delete profile.

#### `GET /api/profiles/search`

Natural language search.

**Query:** `q=female adults from US`

**Response:** Same format as list endpoint.

#### `GET /api/profiles/export`

Export profiles to CSV.

**Query:** `format=csv&gender=male&country_id=NG`

**Response:** CSV file download.

## Rate Limiting

| Scope     | Limit               | Response              |
| --------- | ------------------- | --------------------- |
| `/auth/*` | 10 req/min per IP   | 429 Too Many Requests |
| `/api/*`  | 60 req/min per user | 429 Too Many Requests |

## Logging

All requests are logged with format:

```
[2026-04-26T03:39:02Z] GET /api/profiles 200 45ms
```

## Error Responses

Standard error format:

```json
{
  "status": "error",
  "message": "Error message"
}
```

| Status | Meaning                                        |
| ------ | ---------------------------------------------- |
| 400    | Bad request (missing API version header, etc.) |
| 401    | Unauthorized (missing/invalid token)           |
| 403    | Forbidden (insufficient permissions)           |
| 422    | Validation error                               |
| 429    | Rate limit exceeded                            |
| 500    | Internal server error                          |

## Environment Variables

Create `.env` file:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/insighta_labs?schema=public

# Server
PORT=4888

# JWT
JWT_SECRET=your-256-bit-secret-change-this-in-production
ACCESS_TOKEN_EXPIRES=180
REFRESH_TOKEN_EXPIRES=300

# GitHub OAuth
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
CALLBACK_URL=http://185.200.244.215:9400/auth/github/callback

# Frontend URL
FRONTEND_URL=http://localhost:3000

# Rate Limiting
RATE_LIMIT_WINDOW=60000
AUTH_RATE_LIMIT=10
API_RATE_LIMIT=60
```

## Setup

### Prerequisites

- Node.js v18+
- PostgreSQL database
- GitHub OAuth App (for authentication)

### Installation

```bash
# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Run database migrations (creates User and Session tables)
npm run prisma:migrate

# Seed database with sample data (optional)
npm run seed

# Build for production
npm run build

# Start server
npm start
```

### Development

```bash
# Start development server with hot reload
npm run dev
```

### Testing

```bash
# Run tests
npm test

# Lint code
npm run lint

# Type check
npm run typecheck
```

## CI/CD

GitHub Actions workflow runs on PR to `main`:

- Linting (ESLint)
- Testing (Jest)
- Build checks (TypeScript compilation)

## Deployment

1. Set environment variables in production
2. Run migrations: `npm run prisma:migrate`
3. Build: `npm run build`
4. Start: `npm start`

Recommended deployment: Render, AWS, Railway, or similar platform

## Natural Language Parsing

The system parses queries like:

- `"female adults from US"` → gender=female, age_group=adult, country_id=US
- `"males over 30"` → gender=male, min_age=30
- `"young people"` → age between 16-24
- `"senior profiles from Germany"` → age_group=senior, country_id=DE

## Security Considerations

- All tokens transmitted over HTTPS (production)
- Refresh tokens stored in database, invalidated after use
- HTTP-only cookies prevent XSS token theft
- CSRF protection with SameSite cookies
- PKCE prevents authorization code interception
- Rate limiting prevents brute force attacks
- No secrets in source code (environment variables only)

## Repository Structure

```
├── prisma/
│   ├── schema.prisma          # Database schema
│   ├── seed.ts               # Database seeding
│   └── seed_profiles.json    # Sample data
├── src/
│   ├── app.ts                # Express app setup
│   ├── server.ts             # Server entry point
│   ├── controllers/          # Route controllers
│   ├── middleware/           # Auth, RBAC, logging, etc.
│   ├── routes/               # API routes
│   ├── services/             # Business logic
│   └── utils/                # Helper functions
├── tests/                    # Test files
└── package.json
```

## License

MIT

## Support

For issues and questions, please refer to the main project repository.
