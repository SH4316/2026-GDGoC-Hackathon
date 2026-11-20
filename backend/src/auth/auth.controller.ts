import {
  Body,
  Controller,
  Cookies,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { AuthService, SESSION_TTL_MS } from './auth.service.js';
import { LoginDto } from './login.dto.js';

const SESSION_COOKIE = 'session';

function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api',
  };
}

function requireJson(request: Request) {
  if (!request.is('application/json')) {
    throw new UnsupportedMediaTypeException();
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UseGuards(ThrottlerGuard)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async login(
    @Body() credentials: LoginDto,
    @Cookies(SESSION_COOKIE) previousToken: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireJson(request);
    const { token, user } = await this.auth.login(
      credentials.email,
      credentials.password,
      previousToken,
    );
    response.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions(),
      maxAge: SESSION_TTL_MS,
    });
    return user;
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  session(@Cookies(SESSION_COOKIE) token: string | undefined) {
    return this.auth.getUser(token);
  }

  @Post('logout')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  logout(
    @Cookies(SESSION_COOKIE) token: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    requireJson(request);
    this.auth.revokeSession(token);
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  }
}
