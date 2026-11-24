import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AccessResponse, AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { Public } from './decorator/public.decorator';
import { Roles } from './decorator/roles.decorator';
import { AuthGuard } from './auth.guard';
import { LoginThrottle } from './login-throttle';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  signIn(@Body() data: SignInDto, @Req() request: Request) {
    return this.authService.signIn(data, LoginThrottle.clientAddress(request));
  }

  /**
   * What the signed-in user may see and change, by the API's own rules (src/auth/access.ts):
   * the web client builds its menu and buttons from it (utils/casl.ts).
   */
  @Get('access')
  access(@Req() request: Request): Promise<AccessResponse> {
    return this.authService.accessOf(request['user']);
  }

  /**
   * Signs the current user out on every device: all tokens issued so far stop working,
   * and the CRM bot is unlinked from their Telegram.
   */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Req() request: Request): Promise<void> {
    await this.authService.logoutEverywhere(request['user'].sub);
  }

  /** The admin signs a staff user out on every device (a lost phone) and unlinks their CRM bot. */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout/:id')
  async logoutUser(@Param('id', ParseIntPipe) id: number): Promise<void> {
    await this.authService.logoutEverywhere(id);
  }

  /**
   * «Выдать стандартные права» of the list «Пользователи»: the admin gives an agent the standard rights
   * (own deals, companies, contacts and tasks), e.g. one whose card forbids everything and who sees nothing.
   */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @HttpCode(HttpStatus.OK)
  @Post('standard-rights/:id')
  giveStandardRights(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<{ id: number; permissions: Record<string, any> }> {
    return this.authService.giveStandardRights(id, request['user'].sub);
  }
}
