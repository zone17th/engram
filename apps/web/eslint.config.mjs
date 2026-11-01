import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
      ".playwright-browsers/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["**/*.test.{ts,tsx}", "tests/**", "e2e/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          property: "createVaultNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use createVault({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "unlockPassphraseNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use unlockPassphrase({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "unlockRecoveryNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use unlockRecovery({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "rewrapNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use rewrap({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "makeRecoveryKeysNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use makeRecoveryKeys({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "wrapForDeviceNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use wrapForDevice({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "sealEntryNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use sealEntry({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
        {
          property: "openEntryNow",
          message:
            "Capture opGeneration = client.captureGeneration() before the first await and use openEntry({ ..., opGeneration }) (ADR 0002 §10.2).",
        },
      ],
    },
  },
  {
    files: ["lib/crypto/client.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\./protocol$).+",
              message:
                "client.ts may import only './protocol' to keep libsodium and worker-core out of the main-thread graph (FE2-7).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["lib/crypto/protocol.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: ".+",
              message:
                "protocol.ts must not import any modules (FE2-7).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["features/{items,entries,json-table,omnibox,tags}/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@tanstack/react-query",
              importNames: ["useMutation"],
              message:
                "Use useContentMutation from '@/lib/api/content' instead of useMutation in P04 content features so mutations never carry plaintext in MutationCache (plan §2.10, P4FE2-16).",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;
