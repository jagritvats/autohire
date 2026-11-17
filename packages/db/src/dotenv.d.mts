export declare function parseDotEnv(text: string): Record<string, string>;
export declare function loadEnvFile(path: string, env?: Record<string, string | undefined>): boolean;
export declare function findWorkspaceRoot(startDir?: string): string | null;
export declare function loadRootEnv(startDir?: string, env?: Record<string, string | undefined>): string[];
