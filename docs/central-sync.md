# Alibaba central inventory wiring

The desktop app reads and writes inventory only through the Alibaba ECS API.
RDS is the inventory authority. OSS contains immutable photos and release files;
an OSS JSON object is never a writable inventory source.

## Runtime configuration

Set these user environment variables before launching the installed app:

- `TEK_STOCK_API_BASE_URL`: HTTPS base URL of the ECS API.
- `TEK_STOCK_API_FALLBACK_BASE_URLS`: optional JSON array (or comma-separated
  list) of Alibaba proxy URLs for the same API authority.
- `TEK_STOCK_AUTHORITY_ID`: stable non-secret ID shared by the primary API and
  every fallback proxy.
- `TEK_STOCK_OSS_PUBLIC_BASE_URL`: HTTPS public/photo CDN base URL of the OSS bucket.
- `TEK_STOCK_UPLOAD_TOKEN`: optional initial write token. The UI can securely save
  it with Electron `safeStorage` instead.

The two non-secret URLs can alternatively be stored in:

`%APPDATA%/samlee-inventory-desktop/alibaba-cloud.json`

Use `inventory/alibaba-cloud.example.json` as the schema. Never put the write
token in that file or in the installer.

Release packaging requires `inventory/alibaba-cloud.json` to contain the two
real, credential-free HTTPS endpoints. The package audit rejects a missing file,
example/local/placeholder hosts, URL credentials, query secrets, and any field
other than `apiBaseUrl`, `apiFallbackBaseUrls`, `authorityId`, and
`ossPublicBaseUrl`. Keep the deployment-specific
file out of source control if the endpoints are not intended to be public; place
it in the source tree only for the controlled packaging run.

## Data flow

1. The hidden Excel column B stores the permanent product ID.
2. A blank ID receives a UUID and is written to Excel before any cloud mutation.
3. Excel rows are compared with `_TEK_BASELINE` strictly by ID.
4. Create, field update, and delete operations enter an atomic outbox under the
   Electron user-data directory.
5. Each operation keeps one idempotency key across retries and restarts.
   Reads fail over after a bounded network timeout or HTTP 5xx. Writes do so
   only when they carry that idempotency key; photo presign is the sole
   explicitly safe exception. HTTP 4xx never crosses endpoints.
6. The client consumes `/v1/changes` after its first `/v1/snapshot`; an expired
   cursor falls back to a fresh snapshot.
7. Photos are uploaded with presign/PUT/commit and cached atomically under a
   path derived from both product ID and SHA-256. Cached bytes are hash-verified
   before first use after every restart.

`Update` performs data synchronization only. `Reinstall` remains the verified
MSI installer flow and is the only control highlighted by an app-version mismatch.
