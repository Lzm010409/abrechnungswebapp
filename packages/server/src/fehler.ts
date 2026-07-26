/**
 * Fehler, die auf eine fehlerhafte Eingabe des Nutzers zurueckgehen.
 *
 * Der Fastify-Fehlerbehandler liest `statusCode` aus. Ohne diese Unterscheidung
 * beantwortet der Server auch Tippfehler mit 500 - das liest sich wie ein
 * Serverausfall und schickt die Fehlersuche in die falsche Richtung.
 */
export class EingabeFehler extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'EingabeFehler';
  }
}

/** Angefragte Ressource existiert nicht. */
export class NichtGefunden extends Error {
  readonly statusCode = 404;

  constructor(message: string) {
    super(message);
    this.name = 'NichtGefunden';
  }
}
