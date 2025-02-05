import { decodeBase64, encodeBase64, utf8Decoder, utf8Encoder } from "./base64";

const CREDENTIALS_REGEXP = /^ *(?:[Bb][Aa][Ss][Ii][Cc]) +([A-Za-z0-9._~+/-]+=*) *$/;
const USER_PASS_REGEXP = /^([^:]*):(.*)$/;

/**
 * Parse authorization header, `Basic encodeBase64(user + ":" + pass)`.
 *
 * @ref https://datatracker.ietf.org/doc/html/rfc7617
 * @example
 * serve((req) => {
 *    const basic = parseBasicAuth(req.headers.get("authorization"))
 *    if (!basic || !(basic.username === "admin" && basic.password === "pa$$w0rd")) {
 *        return new Response(null, {
 *            status: 401,
 *            headers: {
 *                "WWW-Authenticate": `Basic realm=""`,
 *            },
 *        })
 *    }
 *    return new Response("welcome to admin page")
 *})
 */
export function parseBasicAuth(authorization: string) {
    const match = CREDENTIALS_REGEXP.exec(authorization);
    if (!match) {
        return undefined;
    }
    let userPass: RegExpExecArray | null = null;
    try {
        userPass = USER_PASS_REGEXP.exec(utf8Decoder.decode(decodeBase64(match[1])));
    } catch {}
    if (!userPass) {
        return undefined;
    }
    return { username: userPass[1], password: userPass[2] };
}

export function buildBasicAuth(user: string, pass: string) {
    return `Basic ${encodeBase64(utf8Encoder.encode(`${user}:${pass}`))}`;
}

const BEARER_REGEXP = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/;

/**
 * @ref https://datatracker.ietf.org/doc/html/rfc6750
 */
export function parseBearerAuth(authorization: string) {
    const match = BEARER_REGEXP.exec(authorization);
    if (match) {
        return match[1];
    } else {
        return undefined;
    }
}

export function buildBearerAuth(bearer: string) {
    return `Bearer ${bearer}`;
}
