import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/** Text fields: spaces around are not part of the value, so "    " is empty and fails @Length. */
export function Trim(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
}

/** An optional field sent as "" by a form is the same as not sent. */
export function EmptyToUndefined(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? undefined : value));
}

/** A phone as people type it: digits with +, spaces, dashes and brackets; 5 to 15 digits. */
export const PHONE_PATTERN = /^\+?(?:[\s\-().]*\d){5,15}[\s\-().]*$/;
export function IsPhoneLike(): PropertyDecorator {
  return Matches(PHONE_PATTERN, { message: 'Телефон: только цифры, пробелы, скобки, дефис и «+» (от 5 до 15 цифр)' });
}
