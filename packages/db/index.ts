import { PrismaClient } from '@prisma/client';

const PrismClientSingleton = () => {
    return new PrismaClient();
}

// type declaration
declare global {
    var prisma : undefined | ReturnType<typeof PrismClientSingleton>;
}

export const prisma = globalThis.prisma ?? PrismClientSingleton()

if(process.env.NODE_ENV !== "production") globalThis.prisma = prisma;