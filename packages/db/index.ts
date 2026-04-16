import { PrismaClient } from "./generated/prisma/client"
import { PrismaPg } from '@prisma/adapter-pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL
})

const PrismClientSingleton = () => {
    return new PrismaClient({ adapter });
}

// type declaration
declare global {
    var prisma : undefined | ReturnType<typeof PrismClientSingleton>;
}

export const prisma = globalThis.prisma ?? PrismClientSingleton()
export * from "./generated/prisma/client"

if(process.env.NODE_ENV !== "production") globalThis.prisma = prisma;


