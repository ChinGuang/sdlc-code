/**
 * What the Run API's own errors mean in HTTP: no such Run is 404, a Run that is
 * not where a request needs it is 409, and a server that cannot run anything
 * yet is 503. The message goes back as it is, because it says what to do.
 */
import {
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  DocumentNotFoundError,
  RunConflictError,
  RunNotFoundError,
  RuntimeUnavailableError,
} from "./runService.js";

/** The one thing this filter does with a response; no express types needed. */
type JsonResponse = {
  status: (code: number) => { json: (body: unknown) => void };
};

const STATUS = new Map<unknown, number>([
  [RunNotFoundError, HttpStatus.NOT_FOUND],
  [DocumentNotFoundError, HttpStatus.NOT_FOUND],
  [RunConflictError, HttpStatus.CONFLICT],
  [RuntimeUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
]);

@Catch(
  RunNotFoundError,
  DocumentNotFoundError,
  RunConflictError,
  RuntimeUnavailableError,
)
export class RunErrorsFilter implements ExceptionFilter {
  catch = (error: Error, host: ArgumentsHost): void => {
    const status =
      STATUS.get(error.constructor) ?? HttpStatus.INTERNAL_SERVER_ERROR;
    host
      .switchToHttp()
      .getResponse<JsonResponse>()
      .status(status)
      .json({ statusCode: status, message: error.message });
  };
}
