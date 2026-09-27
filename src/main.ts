import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';
import { HttpExceptionFilter } from './common/filters';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Attach request logging middleware early in the pipeline
  app.use(requestLogger as any);

  // Global exception filter — structured, consistent error responses (#980)
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global validation pipe (#980 — DTO whitelist / forbidNonWhitelisted)
  //
  // whitelist: true         — strips properties not in the DTO class
  // forbidNonWhitelisted: true — rejects requests with unknown properties (400)
  // transform: true         — auto-coerces payloads to DTO class instances
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap();
