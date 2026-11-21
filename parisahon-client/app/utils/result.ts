export type Result<T, E = Error> =
    | { ok: true, value: T }
    | { ok: false, error: E };

export function Ok<T>(value: T): Result<T> {
    return { ok: true, value };
}

export function Err<T, E>(error: E): Result<T, E> {
    return { ok: false, error: error };
}

export async function promiseResult<T>(promise: Promise<T>): Promise<Result<T, Error>> {
    try {
        const result = await promise;
        return Ok(result);
    } catch (err: any) {
        return Err(err);
    }
}
