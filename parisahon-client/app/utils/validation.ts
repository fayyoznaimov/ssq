import type { Result } from './result';
import {parsePhoneNumber} from 'libphonenumber-js';

type ValidationResult = Result<undefined, string>;
type ValidationFn = (...args: any[]) => ValidationResult;
export type Schema<K extends string> = Record<K, ValidationFn[]>;
export type ErrorObject<K extends string> = Record<K, string>;
export type SchemaResult<K extends string> = {
    valid: boolean;
    errors: ErrorObject<K>;
}

export function validPattern(pattern: RegExp, message: string) {
    return (value: string | undefined): ValidationResult => {
        (value && pattern.test(value)) || message;
        if (value && new RegExp(pattern).test(value)) return {ok: true, value: undefined};
        return {ok: false, error: message};
    };
}

export function validNumber(message: string) {
    return (value: string | undefined): ValidationResult => {
        if (isNaN(Number(value))) return {ok: false, error: message};
        return {ok: true, value: undefined};
    };
}

export function validPhone(message: string): (value: string | undefined) => ValidationResult {
    return (value: string | undefined) => {
        const parsed = parsePhoneNumber(value || '');
        if (!parsed.isValid()) return {ok: false, error: message}
        return {ok: true, value: undefined}
    }
}

export function validEmail(message: string): (value: string | undefined) => ValidationResult {
    return validPattern(/^(([^<>()[\].,;:\s@"]+(\.[^<>()[\].,;:\s@"]+)*)|(".+"))@(([^<>()[\].,;:\s@"]+\.)+[^<>()[\].,;:\s@"]{2,})$/i, message);
}

export function required(message: string) {
    return (value: string | number | undefined): ValidationResult => {
        if (value == null || value == '') return { ok: false, error: message };
        return { ok: true, value: undefined };
    };
}

export function minLength(min: number, message: string) {
    return (value: string | undefined): ValidationResult => {
        if (value && value.length > min) return { ok: true, value: undefined };
        return { ok: false, error: message };
    };
}

export function validateKey<K extends string>(key: K, value: string, schema: Schema<K>): ValidationResult {
    const fns = schema[key];
    for (const fn of fns) {
        const result = fn(value);
        if (!result.ok) {
            return result;
        }
    }

    return {ok: true, value: undefined};
}

export function validateSchema<K extends string>(schema: Schema<K>, data: Record<K, any>): SchemaResult<K> {
    const errors: Record<K, string> = {} as Record<K, any>;
    let valid = true;
    for (const key in schema) {
        const result = validateKey(key, data[key], schema);
        if (!result.ok) {
            errors[key] = result.error;
            valid = false;
        }
    }

    return {errors, valid};
}