import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const payload =
        typeof body === 'string'
          ? { message: body }
          : Array.isArray((body as any).message)
            ? { message: (body as any).message.join(', ') }
            : (body as any);
      res.status(exception.getStatus()).json({
        statusCode: exception.getStatus(),
        error: exception.name,
        ...payload,
      });
      return;
    }

    const pgMessage = (exception as any)?.message ?? 'Internal server error';
    this.logger.error(pgMessage, (exception as any)?.stack);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      message: 'Internal server error',
      error: 'InternalServerError',
    });
  }
}
