export type LogStatus = "STARTED" | "SUCCESS" | "FAILED" | "SKIPPED" | "INFO";

export type LogMeta = Record<string,unknown>;

export type StructuredLogContext = {
    projectId? : string | null;
    userId? : string | null;
    instanceId? : string | null;
    containerName? : string | null;
    operation : string;
    status : LogStatus;
    reason? : string | null;
    meta? : LogMeta;
}

type LogLevel = "info" | "warn" | "error";

export type LoggerBaseContext = {
    projectId? : string | null;
    userId? : string | null;
    instanceId? : string | null;
    containerName? : string | null;
    meta? : LogMeta;
};

type StructuredLogEntry = {
    timestamp: string;
    projectId : string | null;
    userId: string | null;
    instanceId : string | null;
    containerName : string | null;
    operation: string;
    status: LogStatus;
    reason: string | null;
    meta: LogMeta;
};

const normalizeString = (value? : string | null) : string | null => value ?? null;

const buildEntry = (ctx : StructuredLogContext) : StructuredLogEntry => {
    return {
        timestamp: new Date().toISOString(),
        projectId: normalizeString(ctx.projectId),
        userId: normalizeString(ctx.userId),
        instanceId: normalizeString(ctx.instanceId),
        containerName: normalizeString(ctx.containerName),
        operation: ctx.operation,
        status: ctx.status,
        reason : ctx.reason ?? null,
        meta: ctx.meta ?? {},
    };
};

const emit = (level : LogLevel, ctx: StructuredLogContext) : StructuredLogEntry => {
    const entry = buildEntry(ctx);
    const serialized = JSON.stringify(entry);

    if(level === "error"){
        console.error(serialized);
        return entry;
    }

    if(level === "warn"){
        console.warn(serialized);
        return entry;
    }

    console.info(serialized);
    return entry;
};

export const logInfo = (ctx: StructuredLogContext) => emit("info", ctx);
export const logWarn = (ctx: StructuredLogContext) => emit("warn", ctx);
export const logError = (ctx: StructuredLogContext) => emit("error", ctx);

export const createScopedLogger = (base: LoggerBaseContext = {}) => {
    const merge = (ctx : StructuredLogContext) : StructuredLogContext => ({
        projectId : ctx.projectId ?? base.projectId ?? null,
        userId : ctx.userId ?? base.userId ?? null,
        instanceId : ctx.instanceId ?? base.instanceId ?? null,
        containerName : ctx.containerName ?? base.containerName ?? null,
        operation : ctx.operation,
        status : ctx.status,
        reason : ctx.reason,
        meta : { 
            ...(base.meta ?? {}), 
            ...(ctx.meta ?? {}),
        },
    });

    return {
        info : (ctx: StructuredLogContext) => logInfo(merge(ctx)),
        warn : (ctx: StructuredLogContext) => logWarn(merge(ctx)),
        error : (ctx: StructuredLogContext) => logError(merge(ctx)),
        child: (next : LoggerBaseContext = {}) => 
            createScopedLogger({
                projectId: next.projectId ?? base.projectId ?? null,
                userId: next.userId ?? base.userId ?? null,
                instanceId: next.instanceId ?? base.instanceId ?? null,
                containerName: next.containerName ?? base.containerName ?? null,
                meta: {
                    ...(base.meta ?? {}),
                    ...(next.meta ?? {}),
                },
            }),
    };
};