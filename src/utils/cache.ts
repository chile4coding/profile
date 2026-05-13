import Redis from "ioredis";

// Create Redis client
// In production, REDIS_URL comes from environment variables
// Fallback to localhost for development
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new Redis(redisUrl);

// Default TTL for cached queries (5 minutes)
const DEFAULT_QUERY_TTL = 5 * 60;
// TTL for dashboard stats (1 hour)

/**
 * Get a value from cache by key
 */
export async function getFromCache<T>(key: string): Promise<T | null> {
  try {
    const value = await redis.get(key);
    if (value === null) {
      return null;
    }
    return JSON.parse(value) as T;
  } catch (error) {
    console.error("Cache get error:", error);
    return null;
  }
}

/**
 * Set a value in cache with optional TTL
 */
export async function setInCache(
  key: string,
  value: unknown,
  ttlSeconds: number = DEFAULT_QUERY_TTL,
): Promise<boolean> {
  try {
    const serialized = JSON.stringify(value);
    await redis.set(key, serialized, "EX", ttlSeconds);
    return true;
  } catch (error) {
    console.error("Cache set error:", error);
    return false;
  }
}

/**
 * Delete a value from cache by key
 */
export async function deleteFromCache(key: string): Promise<boolean> {
  try {
    await redis.del(key);
    return true;
  } catch (error) {
    console.error("Cache delete error:", error);
    return false;
  }
}

/**
 * Delete all keys matching a pattern
 */
export async function deleteCacheByPattern(pattern: string): Promise<number> {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length === 0) {
      return 0;
    }
    return await redis.del(...keys);
  } catch (error) {
    console.error("Cache pattern delete error:", error);
    return 0;
  }
}


//  this is test coment
/**
 * Generate a cache key for profile queries
 * Uses normalized query filters for consistent caching
 */
export function generateProfileCacheKey(
  queryFilters: unknown,
  page: number,
  limit: number,
  sortBy: string,
  order: string,
): string {
  // Create a deterministic string representation of the query
  const queryString = JSON.stringify({
    filters: queryFilters,
    page,
    limit,
    sortBy,
    order,
  });

  // Use a simple hash or just the string (for simplicity)
  // In production, you might want to use a proper hash function
  return `profiles:query:${Buffer.from(queryString).toString("base64")}`;
}

/**
 * Generate a cache key for dashboard statistics
 */
export function generateDashboardCacheKey(): string {
  return "dashboard:stats";
}

// Health check for Redis connection
export async function checkRedisConnection(): Promise<boolean> {
  try {
    await redis.ping();
    return true;
  } catch (error) {
    console.error("Redis connection check failed:", error);
    return false;
  }
}

export default redis;
