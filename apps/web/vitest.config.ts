import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias:{
            "@":path.resolve(__dirname,"."),
        },
    },
    test: {
        environment: "node",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        clearMocks: true,
        mockReset: true,
        restoreMocks: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: "./coverage",
            include: [
                "app/api/project/route.ts",
                "services/projectControlPlane.ts",
                "services/ec2Manager.ts",
                "services/redisManager.ts",
                "services/runtimeHeartbeatManager.ts",
                "lib/validators/project.ts",
            ],
            exclude: [
                "tests/**",
                "**/*.d.ts",
            ],
        },
    }
})
