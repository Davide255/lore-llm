## Phase 1: Authentication & Identity Management (AWS Cognito)

1. **Initialize the User Pool:** Create a new AWS Cognito User Pool to serve as the centralized identity provider for the multi-tenant environment.
2. **Configure Identity Providers:** Set up standard email/password authentication and integrate **Google SSO** as a federated identity provider to reduce friction for mobile users.
3. **Implement Passkey Registration:** Architect the authentication flow to support **passkey registration**, allowing users to authenticate seamlessly on their mobile devices using biometric hardware (FaceID/TouchID).
4. **Define OAuth Scopes:** Configure the App Client settings and specifically provision the `aws.cognito.signin.user.admin` scope to ensure the mobile app and MCP server have the correct authorized access to read and update user attributes during the session.
5. **Token Generation:** Ensure the authentication flow outputs a standard JWT (ID Token and Access Token) containing the unique `sub` (user_id) claim, which will act as the master key for tenant isolation.

## Phase 2: Knowledge Base Storage Layer (Cloudflare R2)

1. **Provision the Bucket:** Create a single Cloudflare R2 bucket (e.g., `kb-storage-production`) to house all tenant data.
2. **Establish the Directory Schema:** Map the hierarchical knowledge base structure to R2's flat key-value system using the Cognito `user_id` as the root prefix:

- `{user_id}/{project_name}/index.md` (System-compiled)
- `{user_id}/{project_name}/checklist.md` (User-editable)
- `{user_id}/{project_name}/{subfolders}/{file}.md` (User-editable)

3. **Configure CORS:** Set up Cross-Origin Resource Sharing (CORS) rules on the R2 bucket to explicitly allow the mobile app's domain or native app origins (if handling direct uploads) and the Cloudflare Worker's URL.
4. **Set Lifecycle Rules (Optional):** Implement basic lifecycle policies for versioning or soft-deleting `.md` files to allow users to recover accidental deletions from the mobile editor.

## Phase 3: MCP Server & API Logic (Cloudflare Workers)

1. **Initialize the Edge Environment:** Create a Cloudflare Worker using Wrangler (`wrangler init`) and bind the R2 bucket to the Worker's environment variables (e.g., `KB_BUCKET`).
2. **Implement JWT Middleware:** Write an authentication middleware function in the Worker that intercepts incoming requests from the AI agents and the mobile app. This function must decode the Cognito JWT, verify its signature using AWS public JWKs, and extract the `user_id`.
3. **Deploy MCP via SSE:** Expose the MCP tools (read, write, delete, list directories) through an HTTP endpoint using **Server-Sent Events (SSE)**. The AI agent connects to this endpoint, passing the JWT in the `Authorization: Bearer` header.
4. **Enforce Tenant Isolation:** Hardcode the routing logic so that any tool execution automatically prepends the verified `user_id` to the R2 key path. An agent requested to read `ProjectA/checklist.md` is forcibly routed to `{user_id}/ProjectA/checklist.md`.
5. **Automate `index.md` Compilation:** Create a dedicated function within the Worker that triggers whenever a write/edit operation occurs within a project folder. This function will read the updated project state, generate the new Markdown structure for the index, and silently overwrite `{user_id}/{project_name}/index.md` without exposing an edit endpoint for it to the client.

## Phase 4: Mobile Client Integration

1. **Authentication State:** Integrate the AWS Amplify SDK or a lightweight OAuth client to handle the Cognito login, SSO redirects, and passkey handshakes. Store the resulting JWT securely in the device's encrypted keychain.
2. **API Abstraction Layer:** Create a networking class in the mobile app to handle all CRUD operations against the Cloudflare Worker API. Every request must automatically attach the JWT.
3. **UI State Mapping:** Build the UI to visually distinguish the locked `index.md` (read-only view) from the editable `checklist.md` and standard `.md` files.
4. **Agent Handoff:** When the user initiates a session with their AI agent within the app, pass the active Cognito JWT to the agent's initialization payload so it can immediately connect to the MCP Worker.
