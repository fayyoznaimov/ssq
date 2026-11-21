import { $fetch } from "ofetch";

import { createError } from "#app";
import { useApiUrl } from "~/composables/useApiUrl";
import { uploadRequest } from "~/composables/useUpload";
import type { Query } from "~/types/query";
import { parseJwt } from "~/utils/login";

// --- Helper Functions (Keep these as they are) ---

export function useLoggedIn(): boolean {
    try {
        useToken();
        return true;
    } catch (e) {
        return false;
    }
}

export function useToken(): string {
    // Check if localStorage is available (for SSR safety)
    if (typeof localStorage === "undefined") {
        throw new Error("Not authenticated (localStorage unavailable)");
    }
    const token: string | null | undefined = localStorage.getItem("token");
    if (!token)
        throw new Error("Not authenticated (no token)");
    const { exp } = parseJwt(token);
    // Ensure exp exists and is a number
    if (typeof exp !== "number" || exp < Date.now() / 1000) {
        if (typeof localStorage !== "undefined") {
            localStorage.removeItem("token"); // Clean up expired token
        }
        throw new Error("Not authenticated (token expired)");
    }
    return token;
}

function subQueryToString(query: any, baseKey: string): string {
    if (typeof query !== "object" || query === null || Array.isArray(query)) { // Handle arrays directly passed
        if (Array.isArray(query)) {
            return query.map(v => `${baseKey}[]=${encodeURIComponent(v)}`).join("&");
        }
        return `${baseKey}=${encodeURIComponent(query)}`;
    }
    const q: string[] = [];
    Object.entries(query).forEach(([key, value]: [string, any]) => {
        const newBaseKey = `${baseKey}[${key}]`;
        switch (key) {
            case "$nin":
            case "$in":
                if (Array.isArray(value)) {
                    value.forEach((v: any) => {
                        q.push(`${baseKey}[${key}][]=${encodeURIComponent(v)}`);
                    });
                }
                break;
            // Handle common comparison operators ($gt, $lt, etc.)
            case "$gt":
            case "$gte":
            case "$lt":
            case "$lte":
            case "$ne":
                q.push(`${newBaseKey}=${encodeURIComponent(value)}`);
                break;
            default:
                // Recursive call for nested objects, direct append for primitives/arrays
                q.push(subQueryToString(value, newBaseKey));

        }
    });
    return q.join("&");
}

export function queryToString<T = any>(query: Query<T>): string {
    const q: string[] = [];
    Object.entries(query || {}).forEach(([key, value]: [string, any]) => {
        if (value === undefined || value === null) return; // Skip null/undefined values

        switch (key) {
            case "skip":
            case "limit":
                q.push(`${key}=${value}`);
                break;
            case "sort":
                if (typeof value === "object" && value !== null) {
                    Object.entries(value).forEach(([k, v]: [string, any]) => {
                        // Handle potential boolean/number values for sort direction
                        const sortDir = (v === -1 || String(v).toLowerCase() === "desc") ? -1 : 1;
                        q.push(`sort[${k}]=${sortDir}`);
                    });
                }
                break;
            case "or":
            case "and":
                if (Array.isArray(value)) {
                    value.forEach((v: Record<string, any>, i: number) => {
                        // Handle potential empty objects in or/and arrays
                        if (Object.keys(v).length > 0) {
                            q.push(subQueryToString(v, `${key}[${i}]`));
                        }
                    });
                }
                break;
            case "select":
                if (Array.isArray(value)) {
                    value.forEach((v: any) => {
                        q.push(`select[]=${encodeURIComponent(v)}`);
                    });
                } else if (typeof value === "string") { // Allow single string for select
                    q.push(`select[]=${encodeURIComponent(value)}`);
                }
                break;
            default:
                // Use subQueryToString for all other keys, handles nested objects and operators
                q.push(subQueryToString(value, key));
        }
    });
    // Filter out empty strings that might result from empty sub-queries
    return q.filter(part => part !== "").join("&");
}


// --- Service Response Wrapper ---
export interface ServiceResponse<T> {
    _promise: Promise<any>;
    ref: () => ServiceResponse<Ref<UnwrapRef<T>>>;
    list: () => ServiceResponse<any>; // Adjust type if needed, often results in T[]
    exec: () => Promise<T>;
}

function serviceResponse<T extends object | any[]>(promise: Promise<T>): ServiceResponse<T> { // Allow arrays
    return {
        _promise: promise,
        ref() {
            // Ensure T is not an array for ref()
            const p = this._promise.then(r => {
                if (Array.isArray(r)) {
                    console.warn("Using .ref() on an array response. Consider using .list() or ensure the endpoint returns an object.");
                    // Decide how to handle: return ref to array or throw?
                    // For now, let's allow it but it might not be typical Vue ref usage.
                    return ref(r);
                }
                // Ensure T is treated as object for ref()
                return ref<T extends object ? T : object>(r as any);
            });
            return serviceResponse(p as Promise<Ref<UnwrapRef<T>>>) as any; // Cast needed due to conditional logic
        },
        list() {
            // Ensure the response has a 'data' property for paginated lists
            const p = this._promise.then((r: any) => {
                // Common pagination structures: { data: [], total: ... } or just []
                if (Array.isArray(r)) {
                    return r as T; // Assume response is the array itself
                }
                if (r && typeof r === "object" && "data" in r && Array.isArray(r.data)) {
                    return r.data as T; // Assume FeathersJS/common pagination structure
                }
                // If not paginated or array, maybe it's a single object fetch intended for list? Unlikely.
                return Promise.reject(new Error("Response is not an array or a recognized paginated structure ({ data: [...] })"));
            });
            return serviceResponse(p);
        },
        async exec(): Promise<T> { // Return type matches T
            try {
                return await this._promise;
            } catch (e: any) {
                // Improved error handling from ofetch/unjs
                const errorData = e.data || e.response?._data; // Try to get parsed error data
                const statusCode = e.statusCode || e.response?.status || 500;
                const statusMessage = e.statusMessage || e.response?.statusText || "Request Failed";
                const message = errorData?.message || e.message || "An unexpected error occurred";

                console.error(`[Service Error] ${statusCode} ${statusMessage}: ${message}`, errorData || e);

                return Promise.reject(createError({
                    statusCode: statusCode,
                    statusMessage: statusMessage,
                    message: message, // More specific error message
                    data: errorData, // Include detailed error data if available
                    fatal: statusCode >= 500 // Consider server errors fatal
                }));
            }
        }
    };
}


// --- Auth handling ---

let redirectingToLogin = false;

/**
 * The session is over (token missing / expired / rejected by the API):
 * forget the token and go to the login page.
 * A full page load is used on purpose: it also drops everything the SPA keeps
 * in memory for the old session (current user, CASL abilities, the socket).
 */
export function handleUnauthorized(): void {
    if (typeof localStorage !== "undefined") {
        localStorage.removeItem("token");
    }
    if (typeof window === "undefined" || redirectingToLogin) return;
    if (window.location.pathname.replace(/\/+$/, "") === "/login") return;

    redirectingToLogin = true;
    window.location.assign("/login");
}

/** The current token, or null when there is none or it has expired. */
function currentToken(): string | null {
    try {
        return useToken();
    } catch (e) {
        return null;
    }
}

function unauthorizedError() {
    return createError({
        statusCode: 401,
        statusMessage: "Unauthorized",
        message: "Сессия истекла, войдите заново",
    });
}

// --- Main Composable ---

/**
 * `meta.auth` is kept for the existing call sites but no longer decides anything:
 * the API requires a token on every route except auth/login, so the header is
 * sent whenever there is a token.
 */
export const useService = (service: string, meta?: { auth?: boolean }) => {
    const _url = useApiUrl() + (service.startsWith("/") ? service : "/" + service);
    const isLogin = service.replace(/^\/+/, "").startsWith("auth/login");

    /**
     * Built for every request, not once per useService() call, so a component
     * that outlives a re-login never sends the previous user's token.
     */
    function authHeaders(): Record<string, string> {
        const token = currentToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    /** No valid token: do not send a request that can only fail, end the session. */
    function sessionExpired(): boolean {
        if (isLogin || currentToken()) return false;
        handleUnauthorized();
        return true;
    }

    function request<T>(url: string, options: Record<string, any>): Promise<T> {
        if (sessionExpired()) return Promise.reject(unauthorizedError());

        return $fetch<T>(url, {
            ...options,
            headers: authHeaders(),
            onResponseError({ response }) {
                // 401: the API did not accept the token (expired, account deleted, ...).
                // 403 is "not allowed for your role" and must not log the user out.
                if (response.status === 401 && !isLogin) handleUnauthorized();
            },
        }) as Promise<T>;
    }

    return {
        /**
         * Fetch a single resource by ID.
         * GET /service/:id
         */
        get<T extends object = any, V = any>(id: string | number, query?: Query<V>): ServiceResponse<T> {
            let fullUrl = `${_url}/${id}`;
            if (query) {
                fullUrl += "?" + queryToString(query);
            }
            return serviceResponse(request<T>(fullUrl, { method: "GET" }));
        },

        /**
         * Fetch a list of resources, potentially with query parameters.
         * GET /service
         */
        find<T extends object = any, V = any>(query?: Query<V>): ServiceResponse<T> { // T is often Paginated<Something> or Something[]
            let fullUrl = _url;
            if (query) {
                fullUrl += "?" + queryToString(query);
            }
            // Expecting an array or a paginated object structure
            return serviceResponse(request<T>(fullUrl, { method: "GET" }));
        },

        /**
         * Fetch resources from a nested path under a specific parent ID.
         * GET /service/:id/:nestedPath
         */
        getNested<T extends object = any, V = any>(id: string | number, nestedPath: string, query?: Query<V>): ServiceResponse<T> {
            // Ensure nestedPath doesn't start with / to avoid double slashes
            const cleanNestedPath = nestedPath.startsWith("/") ? nestedPath.substring(1) : nestedPath;
            if (!cleanNestedPath) {
                // Handle invalid nestedPath? Or let the API return 404?
                console.warn("getNested called with empty nestedPath");
            }
            let fullUrl = `${_url}/${id}/${cleanNestedPath}`;
            if (query) {
                fullUrl += "?" + queryToString(query);
            }
            // Expecting an array or a paginated object structure from the nested endpoint
            return serviceResponse(request<T>(fullUrl, { method: "GET" }));
        },

        /**
         * Create a new resource.
         * POST /service
         */
        create<T extends object = any>(data: any): ServiceResponse<T> {
            return serviceResponse(request<T>(_url, { method: "POST", body: data }));
        },

        /**
         * Send a POST request to a custom sub-path relative to the service base URL.
         * Can be used for actions or creating nested resources if getNested doesn't fit.
         * POST /service/:path
         */
        post<T extends object = any>(path: string, data: any): ServiceResponse<T> {
            // Ensure path doesn't create double slash if _url ends with / and path starts with /
            const cleanPath = path.startsWith("/") ? path.substring(1) : path;
            const fullUrl = `${_url}/${cleanPath}`; // Use slash separator
            return serviceResponse(request<T>(fullUrl, { method: "POST", body: data }));
        },

        /**
         * Update a resource by ID.
         * PATCH /service/:id
         */
        patch<T extends object = any>(id: string | number, data: any): ServiceResponse<T> {
            return serviceResponse(request<T>(
                `${_url}/${id}`,
                { method: "PATCH", body: data }
            ));
        },

        /**
         * Upload data (typically files) to a custom sub-path.
         * POST /service/:path (often used for uploads)
         */
        upload(path: string, data: FormData | Blob | File, { onProgress = (progress: number) => {}, onDone = (response: any) => {}} = {}) {
            // Ensure path is handled correctly
            const cleanPath = path.startsWith("/") ? path.substring(1) : path;
            const fullUrl = `${_url}/${cleanPath}`;
            if (sessionExpired()) return Promise.reject(unauthorizedError());
            // uploadRequest (XMLHttpRequest) rejects with the parsed response body
            return uploadRequest(fullUrl, { method: "POST", body: data, headers: authHeaders(), onDone, onProgress })
                .catch((error: any) => {
                    if (error?.statusCode === 401) handleUnauthorized();
                    throw error;
                });
        },

        /**
         * Delete a resource by ID.
         * DELETE /service/:id
         */
        remove<T extends object = any>(id: string | number): ServiceResponse<T> {
            return serviceResponse(request<T>(
                `${_url}/${id}`,
                { method: "DELETE" })
            );
        }
    };
};
