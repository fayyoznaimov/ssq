import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SignInDto } from './dto/sign-in.dto';
import { RoleEnum, User } from '../user/user.entity';

@Injectable()
export class AuthService {
  // Compared against when the account does not exist or cannot log in, so
  // that the response time does not reveal which emails are registered.
  private static readonly DUMMY_HASH = bcrypt.hashSync('no-such-account', 10);

  constructor(
    private userService: UserService,
    private jwtService: JwtService,
  ) {}

  /**
   * One and the same 401 for: unknown email, wrong password, deleted account
   * and ctr_agent (customer contact records have no password and must never
   * be able to log in).
   */
  async signIn(data: SignInDto): Promise<any> {
    const user = await this.userService.findForLogin(data.email);

    const canLogIn =
      !!user &&
      user.role !== RoleEnum.CTR_AGENT &&
      typeof user.password === 'string' &&
      user.password.length > 0;

    const passwordMatches = await bcrypt.compare(
      data.password,
      canLogIn ? user.password : AuthService.DUMMY_HASH,
    );

    if (!canLogIn || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.generateToken(user);
  }

  async generateToken(user: User): Promise<any> {
    return {
      access_token: await this.jwtService.signAsync({
        sub: user.id,
        username: user.username,
        role: user.role,
        permissions: user.permissions,
      }),
      id: user.id,
      role: user.role,
      username: user.username,
    };
  }
}
