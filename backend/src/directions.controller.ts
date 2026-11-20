import { BadRequestException, Controller, Get, Header, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { coordinate } from './directions/provider.js';
import { DirectionsService } from './directions/service.js';

const querySchema = z.strictObject({
  start_x: coordinate(180), start_y: coordinate(90),
  end_x: coordinate(180), end_y: coordinate(90),
});

@Controller('api/directions')
export class DirectionsController {
  constructor(private readonly service: DirectionsService) {}

  @Get('places')
  @Header('Cache-Control', 'no-store')
  async places(@Query('q') input: unknown) {
    const query = z.string().trim().min(1).max(80).safeParse(input);
    if (!query.success) throw new BadRequestException('Enter a place name (1–80 characters)');
    return this.service.searchPlaces(query.data);
  }

  @Get(':mode')
  @Header('Cache-Control', 'no-store')
  async directions(@Param('mode') mode: string, @Query() input: unknown) {
    if (mode !== 'walk' && mode !== 'transit') throw new BadRequestException('Use walk or transit');
    const query = querySchema.safeParse(input);
    if (!query.success) {
      throw new BadRequestException('Expected start_x, start_y, end_x and end_y in WGS84 (x = longitude, y = latitude)');
    }
    return this.service.findRoute(mode, query.data);
  }
}
