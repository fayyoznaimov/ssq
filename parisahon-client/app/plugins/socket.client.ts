import { io } from "socket.io-client";

/**
 * The API accepts a socket only with a valid JWT (see
 * parisahon-api/src/gateway/notification.gateway.ts).
 *
 * - `auth` is a function, so the token is read from localStorage on every
 *   (re)connection attempt and not once when the app starts.
 * - The socket is not opened while there is no token (login page), and is
 *   re-opened after navigation when the token appeared or changed (login,
 *   re-login as another user). socket.io does not retry by itself after the
 *   server refused the handshake, so this is also what reconnects it then.
 */
export default defineNuxtPlugin((nuxtApp) => {
    if (!import.meta.client) return;

    // useLoggedIn() also drops an expired token
    const readToken = () => (useLoggedIn() ? localStorage.getItem("token") : null);

    let usedToken: string | null = null;

    const socket = io(useRuntimeConfig().public.socketUrl as string, {
        transports: ["websocket"],
        autoConnect: false,
        auth: (cb) => {
            usedToken = readToken();
            cb({ token: usedToken });
        },
    });

    function sync() {
        const token = readToken();

        if (!token) {
            usedToken = null;
            if (socket.connected || socket.active) socket.disconnect();
            return;
        }

        // another user logged in: the open connection belongs to the old token
        if (socket.connected && usedToken !== token) socket.disconnect();
        if (!socket.connected && !socket.active) socket.connect();
    }

    sync();
    useRouter().afterEach(() => sync());

    nuxtApp.provide("socket", socket);
});
