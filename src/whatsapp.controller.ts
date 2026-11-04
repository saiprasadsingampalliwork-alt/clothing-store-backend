import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { WhatsAppService } from "./whatsapp.service";

@Controller("whatsapp")
export class WhatsAppController {
  constructor(@Inject(WhatsAppService) private readonly whatsapp: WhatsAppService) {}

  @Get("webhook")
  @Header("content-type", "text/plain")
  verify(
    @Query("hub.mode") hubMode?: string,
    @Query("hub.verify_token") hubVerifyToken?: string,
    @Query("hub.challenge") hubChallenge?: string,
    @Req() req?: Request,
  ) {
    const query = req?.query as Record<string, string | undefined> | undefined;
    const mode = hubMode || query?.["hub.mode"] || query?.["hub_mode"];
    const verifyToken = hubVerifyToken || query?.["hub.verify_token"] || query?.["hub_verify_token"];
    const challenge = hubChallenge || query?.["hub.challenge"] || query?.["hub_challenge"];

    const challengeResponse = this.whatsapp.verifyWebhook(mode, verifyToken, challenge);
    if (!challengeResponse) {
      throw new ForbiddenException("WhatsApp webhook verification token mismatch.");
    }
    return challengeResponse;
  }

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: any,
    @Headers("x-hub-signature-256") signature?: string,
  ) {
    if (!this.whatsapp.verifySignature(req.rawBody, signature)) {
      throw new UnauthorizedException("WhatsApp webhook signature could not be verified.");
    }
    // Meta retries a webhook that is not answered quickly, so it is acknowledged now and handled in the background
    // (handling can send emails). Repeats are still ignored inside processWebhook.
    void this.whatsapp.processWebhook(body).catch((error) => console.error("[whatsapp] Webhook could not be handled", error));
    return { ok: true };
  }
}

