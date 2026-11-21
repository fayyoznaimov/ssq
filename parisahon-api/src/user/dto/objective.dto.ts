import { IsNumber } from 'class-validator';

export class Objective {
  @IsNumber()
  monthly: number;

  @IsNumber()
  quarterly: number;

  @IsNumber()
  yearly: number;
}
