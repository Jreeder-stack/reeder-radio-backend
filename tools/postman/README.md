# CAD Radio API — Postman Collection

  Two files for testing the CAD Radio API in Postman:

  - `cad-radio-api.postman_collection.json` — every endpoint, organised
    by section, pre-wired with example bodies and `{{cad_url}}` /
    `{{cad_key}}` variables.
  - `cad-radio-api.postman_environment.json` — empty environment with
    `cad_url` and `cad_key` (`cad_key` is a secret-typed variable).

  ## Three steps to use

  1. **Import** both files into Postman:
     *File → Import* → drop the two `.json` files.
  2. **Pick** the **CAD Radio API** environment in the top-right env
     selector.
  3. **Fill in** the values:
     - `cad_url` — your CAD base URL, e.g. `https://your-cad-host`
       (no trailing slash).
     - `cad_key` — your CAD API key (the value of the
       `CAD_API_KEY` / `CAD_INTEGRATION_KEY` secret).

  Then open any request and hit **Send**.

  ## Auth

  Every request sends the header `X-API-Key: {{cad_key}}` automatically
  (collection-level auth). You don't need to add it per request.

  ## Path-param helpers

  Some endpoints take IDs in the path. Set these as collection variables
  (or per-request) to avoid hand-editing each URL:

  - `unit_id` — defaults to `INDIANA-1`.
  - `call_id` — paste a real call UUID after you create one.
  - `chat_id`, `vehicle_id`, `category_key` — same idea.

  A typical flow: hit **Calls for Service → Create a new call**, copy the
  `call_id` from the response into the collection variable, then
  **Assign unit to call** / **Add note** / **Dispose** all just work.

  ## Notes

  - The `Reference Data → Get dispositions (general API)` request points
    at `/api/dropdown-options?category=dispositions` (not under
    `/api/radio`). It's the same auth header.
  - The collection mirrors the spec snake_case bodies (`unit_id`,
    `call_id`, etc.). If your CAD instance expects camelCase, edit the
    request body inline — Postman won't fight you.
  