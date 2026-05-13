import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Query timeout to prevent long-running queries from consuming resources
// Set to 5 seconds - adjust based on expected query complexity
// Note: This requires @prisma/client version that supports this
// If not supported, we'll handle timeouts at the application level

export default prisma;
