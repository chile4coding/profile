import { Request, Response } from "express";
import prisma from "../services/db";
import { enrichProfile } from "../services/enrichment";
import { classifyAge } from "../utils/classify";
import { toSnake, toSnakeList } from "../utils/serializer";
import {
  parseNaturalLanguageQuery,
  normalizeQueryFilters,
} from "../services/queryParser";
import {
  generateProfileCacheKey,
  getFromCache,
  setInCache,
  deleteCacheByPattern,
} from "../services/cache";
import { AuthRequest } from "../middleware/auth";
import fs from "fs";
import csv from "csv-parser";

import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

type SortField = "age" | "created_at" | "gender_probability";
type SortOrder = "asc" | "desc";

interface ProfileQueryParams {
  gender?: string;
  age_group?: string;
  country_id?: string;
  min_age?: number;
  max_age?: number;
  min_gender_probability?: number;
  min_country_probability?: number;
  sort_by?: SortField;
  order?: SortOrder;
  page?: number;
  limit?: number;
}

interface ValidationResult {
  error?: { status: number; message: string };
  params?: ProfileQueryParams;
}

const CHUNK_SIZE = 5_000;

const CSV_HEADERS = [
  "id",
  "name",
  "gender",
  "gender_probability",
  "age",
  "age_group",
  "country_id",
  "country_name",
  "country_probability",
  "created_at",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ProfileRow = {
  id: string;
  name: string | null;
  gender: string | null;
  genderProbability: number | null;
  age: number | null;
  ageGroup: string | null;
  countryId: string | null;
  countryName: string | null;
  countryProbability: number | null;
  createdAt: Date | null;
};

// ---------------------------------------------------------------------------
// Cursor-based async generator
// Uses `id > lastSeenId` instead of skip/offset so Postgres seeks directly
// to the next page via the primary key index — O(1) cost at any depth.
// ---------------------------------------------------------------------------
async function* cursorStream(
  where: Record<string, unknown>,
  orderBy: Record<string, string>,
): AsyncGenerator<ProfileRow[]> {
  let lastSeenId: string | null = null;

  while (true) {
    const cursor = lastSeenId ? { ...where, id: { gt: lastSeenId } } : where;

    const chunk: ProfileRow[] = await prisma.profile.findMany({
      where: cursor,
      orderBy: [{ id: "asc" }, orderBy], // id must lead for a stable cursor
      take: CHUNK_SIZE,
      select: {
        id: true,
        name: true,
        gender: true,
        genderProbability: true,
        age: true,
        ageGroup: true,
        countryId: true,
        countryName: true,
        countryProbability: true,
        createdAt: true,
      },
    });

    if (chunk.length === 0) break;

    yield chunk;

    lastSeenId = chunk[chunk.length - 1].id;
    if (chunk.length < CHUNK_SIZE) break; // last page
  }
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowToCSV(profile: ProfileRow): string {
  return [
    profile.id,
    profile.name ?? "",
    profile.gender ?? "",
    profile.genderProbability?.toString() ?? "",
    profile.age?.toString() ?? "",
    profile.ageGroup ?? "",
    profile.countryId ?? "",
    profile.countryName ?? "",
    profile.countryProbability?.toString() ?? "",
    profile.createdAt ? new Date(profile.createdAt).toISOString() : "",
  ]
    .map(escapeCSV)
    .join(",");
}

function createCSVTransform(): Transform {
  return new Transform({
    writableObjectMode: true, // accepts ProfileRow[] objects
    readableObjectMode: false, // emits string buffers
    transform(chunk: ProfileRow[], _encoding, callback) {
      try {
        const lines = chunk.map(rowToCSV).join("\n") + "\n";
        callback(null, lines);
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

function parseQueryParams(query: Record<string, unknown>): ValidationResult {
  const params: Partial<ProfileQueryParams> = {};

  if (query.gender !== undefined) {
    if (typeof query.gender !== "string") {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    const validGenders = ["male", "female"];
    if (!validGenders.includes(query.gender.toLowerCase())) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.gender = query.gender.toLowerCase();
  }

  if (query.age_group !== undefined) {
    if (typeof query.age_group !== "string") {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    const validAgeGroups = ["child", "teenager", "adult", "senior"];
    if (!validAgeGroups.includes(query.age_group.toLowerCase())) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.age_group = query.age_group.toLowerCase();
  }

  if (query.country_id !== undefined) {
    if (typeof query.country_id !== "string") {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.country_id = query.country_id.toUpperCase();
  }

  if (query.min_age !== undefined) {
    const val = Number(query.min_age);
    if (isNaN(val) || val < 0 || !Number.isInteger(val)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.min_age = val;
  }

  if (query.max_age !== undefined) {
    const val = Number(query.max_age);
    if (isNaN(val) || val < 0 || !Number.isInteger(val)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.max_age = val;
  }

  if (query.min_gender_probability !== undefined) {
    const val = Number(query.min_gender_probability);
    if (isNaN(val) || val < 0 || val > 1) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.min_gender_probability = val;
  }

  if (query.min_country_probability !== undefined) {
    const val = Number(query.min_country_probability);
    if (isNaN(val) || val < 0 || val > 1) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.min_country_probability = val;
  }

  // ---- sort_by ----
  if (query.sort_by !== undefined) {
    const raw = Array.isArray(query.sort_by) ? query.sort_by[0] : query.sort_by;
    const sortBy = typeof raw === "string" ? raw.trim() : null;

    const validSortFields: SortField[] = [
      "age",
      "created_at",
      "gender_probability",
    ];

    if (!sortBy || !validSortFields.includes(sortBy as SortField)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }

    params.sort_by = sortBy as SortField;
  }

  // ---- order ----
  if (query.order !== undefined) {
    const raw = Array.isArray(query.order) ? query.order[0] : query.order;
    const order = typeof raw === "string" ? raw.trim().toLowerCase() : null;

    if (!order || !["asc", "desc"].includes(order)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }

    params.order = order as SortOrder;
  }

  // ---- page ----
  if (query.page !== undefined) {
    const page = Number(query.page);
    if (isNaN(page) || page < 1 || !Number.isInteger(page)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.page = page;
  } else {
    params.page = 1;
  }

  // ---- limit ----
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (isNaN(limit) || limit < 1 || !Number.isInteger(limit)) {
      return { error: { status: 422, message: "Invalid query parameters" } };
    }
    params.limit = Math.min(limit, 50);
  } else {
    params.limit = 10;
  }

  return { params };
}

function buildWhereClause(params: ProfileQueryParams): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (params.gender) {
    where.gender = { equals: params.gender, mode: "insensitive" };
  }
  if (params.age_group) {
    where.ageGroup = { equals: params.age_group, mode: "insensitive" };
  }
  if (params.country_id) {
    where.countryId = { equals: params.country_id, mode: "insensitive" };
  }

  if (params.min_age !== undefined || params.max_age !== undefined) {
    where.age = {
      ...(params.min_age !== undefined && { gte: params.min_age }),
      ...(params.max_age !== undefined && { lte: params.max_age }),
    };
  }

  if (params.min_gender_probability !== undefined) {
    where.genderProbability = { gte: params.min_gender_probability };
  }

  if (params.min_country_probability !== undefined) {
    where.countryProbability = { gte: params.min_country_probability };
  }

  return where;
}

function buildSortClause(params: ProfileQueryParams): Record<string, unknown> {
  const fieldMap: Record<SortField, string> = {
    age: "age",
    created_at: "createdAt",
    gender_probability: "genderProbability",
  };

  const field = params.sort_by != null ? fieldMap[params.sort_by] : "createdAt";
  const order = params.order ?? "asc";

  return { [field]: order };
}

export async function createProfile(req: AuthRequest, res: Response) {
  try {
    const { name } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ status: "error", message: "Missing or empty name" });
    }

    if (typeof name !== "string") {
      return res.status(422).json({ status: "error", message: "Invalid type" });
    }

    const normalizedName = name.trim().toLowerCase();

    if (!normalizedName) {
      return res
        .status(400)
        .json({ status: "error", message: "Missing or empty name" });
    }

    const existing = await prisma.profile.findUnique({
      where: { name: normalizedName },
    });

    if (existing) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: toSnake(existing),
      });
    }

    const enriched = await enrichProfile(normalizedName);
    enriched.ageGroup = classifyAge(enriched.age);

    try {
      const profile = await prisma.profile.create({
        data: {
          name: normalizedName,
          gender: enriched.gender,
          genderProbability: enriched.genderProbability,
          age: enriched.age,
          ageGroup: enriched.ageGroup,
          countryId: enriched.countryId,
          countryProbability: enriched.countryProbability,
          countryName: enriched.countryName,
          userId: req.user?.userId,
        },
      });

      return res
        .status(201)
        .json({ status: "success", data: toSnake(profile) });
    } catch (createErr: unknown) {
      if (
        typeof createErr === "object" &&
        createErr !== null &&
        "code" in createErr &&
        (createErr as any).code === "P2002"
      ) {
        const existing = await prisma.profile.findUnique({
          where: { name: normalizedName },
        });
        if (existing) {
          return res.status(200).json({
            status: "success",
            message: "Profile already exists",
            data: toSnake(existing),
          });
        }
      }
      throw createErr;
    }
  } catch (err: unknown) {
    if (err instanceof Error) {
      if (
        err.message.includes("Genderize") ||
        err.message.includes("Agify") ||
        err.message.includes("Nationalize")
      ) {
        return res.status(502).json({
          status: "error",
          message: err.message,
        });
      }
    }
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function getProfileById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const profile = await prisma.profile.findUnique({ where: { id } });

    if (!profile) {
      return res
        .status(404)
        .json({ status: "error", message: "Profile not found" });
    }

    return res.status(200).json({ status: "success", data: toSnake(profile) });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function getProfiles(req: AuthRequest, res: Response) {
  try {
    const result = parseQueryParams(req.query as Record<string, unknown>);

    if (result.error) {
      return res
        .status(result.error.status)
        .json({ status: "error", message: result.error.message });
    }

    const params = result.params!;

    // Normalize query filters for consistent caching
    const normalizedFilters = normalizeQueryFilters(params);

    // Generate cache key
    const cacheKey = generateProfileCacheKey(
      normalizedFilters,
      params.page!,
      params.limit!,
      params.sort_by || "created_at",
      params.order || "asc",
    );

    // Try to get from cache first
    const cachedResult = await getFromCache(cacheKey);
    if (cachedResult) {
      return res.status(200).json(cachedResult);
    }

    const where = buildWhereClause(params);
    const orderBy = buildSortClause(params);

    const skip = (params.page! - 1) * params.limit!;
    const take = params.limit!;

    const [profiles, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      prisma.profile.count({ where }),
    ]);

    const totalPages = Math.ceil(total / params.limit!);

    const baseUrl = `${req.protocol}://${req.get("host")}${req.baseUrl}`;
    const queryParams = new URLSearchParams();
    Object.entries(req.query).forEach(([key, value]) => {
      if (key !== "page" && key !== "limit") {
        if (Array.isArray(value)) {
          value.forEach((v) => queryParams.append(key, v as string));
        } else if (value !== undefined) {
          queryParams.append(key, value as string);
        }
      }
    });

    const selfUrl = `${baseUrl}/profiles?page=${params.page}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`;
    const nextUrl =
      params?.page && params.page < totalPages
        ? `${baseUrl}/profiles?page=${params.page + 1}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`
        : null;
    const prevUrl =
      params?.page && params.page > 1
        ? `${baseUrl}/profiles?page=${params.page - 1}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`
        : null;

    const resultData = {
      status: "success",
      page: params.page,
      limit: params.limit,
      total,
      total_pages: totalPages,
      links: {
        self: `/api/profiles?page=${params.page}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`,
        next: nextUrl
          ? `/api/profiles?page=${params.page ? params?.page + 1 : 1}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`
          : null,
        prev: prevUrl
          ? `/api/profiles?page=${params.page ? params?.page - 1 : 1}&limit=${params.limit}${queryParams.toString() ? "&" + queryParams.toString() : ""}`
          : null,
      },
      data: profiles.map(toSnakeList),
    };

    // Cache the result
    await setInCache(cacheKey, resultData, 300); // 5 minutes TTL

    return res.status(200).json(resultData);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function deleteProfile(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const profile = await prisma.profile.findUnique({ where: { id } });

    if (!profile) {
      return res
        .status(404)
        .json({ status: "error", message: "Profile not found" });
    }

    await prisma.profile.delete({ where: { id } });

    return res.status(204).send();
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function searchProfiles(req: AuthRequest, res: Response) {
  try {
    const { q } = req.query;

    if (!q || typeof q !== "string" || q.trim() === "") {
      return res
        .status(400)
        .json({ status: "error", message: "Missing or empty parameter" });
    }

    const parsed = parseNaturalLanguageQuery(q);

    if (!parsed) {
      return res
        .status(400)
        .json({ status: "error", message: "Unable to interpret query" });
    }

    const queryParams: ProfileQueryParams = {
      ...parsed,
      page: 1,
      limit: 10,
    };

    if (req.query.page) {
      const page = Number(req.query.page);
      queryParams.page = !isNaN(page) && page >= 1 ? page : 1;
    }
    if (req.query.limit) {
      const limit = Number(req.query.limit);
      queryParams.limit =
        !isNaN(limit) && limit >= 1 ? Math.min(limit, 50) : 10;
    }

    // Normalize query filters for consistent caching
    const normalizedFilters = normalizeQueryFilters(queryParams);

    // Generate cache key
    const cacheKey = generateProfileCacheKey(
      normalizedFilters,
      queryParams.page!,
      queryParams.limit!,
      queryParams.sort_by || "created_at",
      queryParams.order || "asc",
    );

    // Try to get from cache first
    const cachedResult = await getFromCache(cacheKey);
    if (cachedResult) {
      return res.status(200).json(cachedResult);
    }

    const where = buildWhereClause(queryParams);
    const orderBy = buildSortClause(queryParams);
    const skip = (queryParams.page! - 1) * queryParams.limit!;
    const take = queryParams.limit!;

    const [profiles, total] = await Promise.all([
      prisma.profile.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      prisma.profile.count({ where }),
    ]);

    const totalPages = Math.ceil(total / queryParams.limit!);

    const baseUrl = `${req.protocol}://${req.get("host")}${req.baseUrl}`;
    const queryParamsStr = new URLSearchParams();
    Object.entries(req.query).forEach(([key, value]) => {
      if (key !== "page" && key !== "limit" && key !== "q") {
        if (Array.isArray(value)) {
          value.forEach((v) => queryParamsStr.append(key, v as string));
        } else if (value !== undefined) {
          queryParamsStr.append(key, value as string);
        }
      }
    });

    const resultData = {
      status: "success",
      page: queryParams.page,
      limit: queryParams.limit,
      total,
      total_pages: totalPages,
      links: {
        self: `/api/profiles/search?q=${encodeURIComponent(q)}&page=${queryParams.page}&limit=${queryParams.limit}${queryParamsStr.toString() ? "&" + queryParamsStr.toString() : ""}`,
        next:
          queryParams?.page && queryParams?.page < totalPages
            ? `/api/profiles/search?q=${encodeURIComponent(q)}&page=${queryParams.page + 1}&limit=${queryParams.limit}${queryParamsStr.toString() ? "&" + queryParamsStr.toString() : ""}`
            : null,
        prev:
          queryParams?.page && queryParams?.page > 1
            ? `/api/profiles/search?q=${encodeURIComponent(q)}&page=${queryParams.page - 1}&limit=${queryParams.limit}${queryParamsStr.toString() ? "&" + queryParamsStr.toString() : ""}`
            : null,
      },
      data: profiles.map(toSnakeList),
    };

    // Cache the result
    await setInCache(cacheKey, resultData, 300); // 5 minutes TTL

    return res.status(200).json(resultData);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}

export async function exportProfiles(req: AuthRequest, res: Response) {
  try {
    const { format } = req.query;

    if (format !== "csv") {
      return res.status(400).json({
        status: "error",
        message: "Only CSV format is supported",
      });
    }

    // Parse filters — reuses the same logic as getProfiles
    const result = parseQueryParams(req.query as Record<string, unknown>);
    const params = result.params ?? { page: 1, limit: 50 };
    const where = buildWhereClause(params);

    const fieldMap: Record<string, string> = {
      age: "age",
      created_at: "createdAt",
      gender_probability: "genderProbability",
    };
    const sortBy = (params.sort_by as string) || "created_at";
    const order = (params.order as string) || "asc";
    const orderBy = { [fieldMap[sortBy] ?? "createdAt"]: order };

    // Tell the browser to download a file instead of rendering it
    const filename = `profiles-export-${Date.now()}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Transfer-Encoding", "chunked"); // stream without a known Content-Length
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.flushHeaders(); // flush headers immediately so the browser starts the download

    // Write CSV header row before the stream starts
    res.write(CSV_HEADERS.join(",") + "\n");

    // Wire up: DB cursor → CSV transform → HTTP response
    const source = Readable.from(cursorStream(where, orderBy), {
      objectMode: true,
    });
    const transform = createCSVTransform();

    // If the client disconnects mid-download, abort the DB cursor cleanly
    req.on("close", () => {
      source.destroy();
      transform.destroy();
    });

    await pipeline(source, transform, res);
  } catch (err) {
    console.error("Export error:", err);

    // Headers already sent — we can't send a JSON error anymore,
    // so just end the response to avoid hanging the browser download.
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ status: "error", message: "Export failed" });
    }

    res.end();
  }
}

/**
 * Upload and process CSV file containing profile data
 * Handles large files via streaming, validates rows, and inserts in batches
 */
export async function uploadProfilesCsv(req: AuthRequest, res: Response) {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded",
      });
    }

    // Initialize counters
    let totalRows = 0;
    let insertedCount = 0;
    let skippedCount = 0;
    const skipReasons: Record<string, number> = {
      duplicate_name: 0,
      invalid_age: 0,
      missing_fields: 0,
      invalid_gender: 0,
      malformed_row: 0,
    };

    // Batch processing configuration
    const batchSize = 1000;
    const batch: any[] = [];
    const namesInBatch: string[] = [];

    // Create read stream from uploaded file
    const fileStream = fs.createReadStream(req.file.path);
    const csvStream = csv();

    // Process CSV stream
    await new Promise((resolve, reject) => {
      fileStream
        .pipe(csvStream)
        .on("data", async (row) => {
          totalRows++;

          // Pause stream while we process this row (to avoid overwhelming memory)
          csvStream.pause();

          try {
            // Validate required fields
            if (!row.name || typeof row.name !== "string" || !row.name.trim()) {
              skipReasons.missing_fields++;
              skippedCount++;
              csvStream.resume();
              return;
            }

            const normalizedName = row.name.trim().toLowerCase();
            if (!normalizedName) {
              skipReasons.missing_fields++;
              skippedCount++;
              csvStream.resume();
              return;
            }

            // Validate age if present
            if (row.age !== undefined && row.age !== "") {
              const age = parseInt(row.age, 10);
              if (isNaN(age) || age < 0) {
                skipReasons.invalid_age++;
                skippedCount++;
                csvStream.resume();
                return;
              }
              row.age = age;
            }

            // Validate gender if present
            if (row.gender !== undefined && row.gender !== "") {
              const gender = row.gender.toLowerCase().trim();
              if (!["male", "female"].includes(gender)) {
                skipReasons.invalid_gender++;
                skippedCount++;
                csvStream.resume();
                return;
              }
              row.gender = gender;
            }

            // Add to batch for processing
            batch.push({
              name: normalizedName,
              gender: row.gender,
              age:
                row.age !== undefined && row.age !== ""
                  ? parseInt(row.age, 10)
                  : undefined,
              // Other fields will be enriched later
            });
            namesInBatch.push(normalizedName);

            // Process batch when it reaches batchSize
            if (batch.length >= batchSize) {
              await processBatch(batch, namesInBatch, skipReasons);
              insertedCount += batch.length;
              batch.length = 0;
              namesInBatch.length = 0;
            }
          } catch (err) {
            skipReasons.malformed_row++;
            skippedCount++;
            console.error("Error processing CSV row:", err);
          } finally {
            csvStream.resume();
          }
        })
        .on("end", async () => {
          // Process remaining rows in batch
          if (batch.length > 0) {
            await processBatch(batch, namesInBatch, skipReasons);
            insertedCount += batch.length;
          }
          resolve(true);
        })
        .on("error", (error) => {
          reject(error);
        });
    });

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    // Prepare response
    const response = {
      status: "success",
      total_rows: totalRows,
      inserted: insertedCount,
      skipped: skippedCount,
      reasons: {
        duplicate_name: skipReasons.duplicate_name,
        invalid_age: skipReasons.invalid_age,
        missing_fields: skipReasons.missing_fields,
        invalid_gender: skipReasons.invalid_gender,
        malformed_row: skipReasons.malformed_row,
      },
    };

    (
      Object.keys(response.reasons) as (keyof typeof response.reasons)[]
    ).forEach((key) => {
      if (response.reasons[key] === 0) {
        delete response.reasons[key];
      }
    });

    return res.status(200).json(response);
  } catch (err) {
    console.error("CSV upload error:", err);
    // Try to clean up file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      status: "error",
      message: "Failed to process CSV upload",
    });
  }
}

/**
 * Process a batch of profile records
 * Checks for duplicates and inserts valid records
 */
async function processBatch(batch: any[], names: string[], skipReasons: any) {
  try {
    // Check for existing names in database
    const existingProfiles = await prisma.profile.findMany({
      where: {
        name: {
          in: names,
        },
      },
      select: {
        name: true,
      },
    });

    const existingNames = new Set(existingProfiles.map((p) => p.name));

    // Filter out duplicates and prepare for insertion
    const validProfiles: any[] = [];

    for (let i = 0; i < batch.length; i++) {
      const profileData = batch[i];
      const name = names[i];

      // Skip if name already exists
      if (existingNames.has(name)) {
        skipReasons.duplicate_name++;
        continue;
      }

      // Enrich the profile data
      try {
        const enriched = await enrichProfile(name);
        profileData.gender = enriched.gender ?? profileData.gender;
        profileData.genderProbability = enriched.genderProbability;
        profileData.age = enriched.age ?? profileData.age;
        profileData.ageGroup = classifyAge(profileData.age);
        profileData.countryId = enriched.countryId;
        profileData.countryProbability = enriched.countryProbability;
        profileData.countryName = enriched.countryName;

        validProfiles.push({
          name: profileData.name,
          gender: profileData.gender,
          genderProbability: profileData.genderProbability,
          age: profileData.age,
          ageGroup: profileData.ageGroup,
          countryId: profileData.countryId,
          countryProbability: profileData.countryProbability,
          countryName: profileData.countryName,
        });
      } catch (enrichError) {
        // If enrichment fails, we still create the profile with available data
        // Set defaults for missing enriched fields
        profileData.ageGroup = classifyAge(profileData.age);
        validProfiles.push({
          name: profileData.name,
          gender: profileData.gender,
          genderProbability: profileData.genderProbability,
          age: profileData.age,
          ageGroup: profileData.ageGroup,
          countryId: profileData.countryId,
          countryProbability: profileData.countryProbability,
          countryName: profileData.countryName,
        });
      }
    }

    // Insert valid profiles in batch
    if (validProfiles.length > 0) {
      await prisma.profile.createMany({
        data: validProfiles,
        skipDuplicates: true, // This will skip duplicates at DB level too
      });
    }
  } catch (error) {
    console.error("Error processing batch:", error);
    // If batch fails, we still want to continue with other batches
    // Individual row errors are handled in the streaming process
    throw error;
  }
}
