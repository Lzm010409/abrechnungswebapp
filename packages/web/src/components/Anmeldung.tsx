/**
 * Anmeldeseite.
 *
 * Das Frontend selbst ist oeffentlich erreichbar - geschuetzt ist die API.
 * Ohne gueltige Sitzung antwortet /api/capabilities mit `angemeldet: false`
 * und die Anwendung zeigt statt der Monatsansicht diese Seite.
 */
export function Anmeldung() {
  const ziel = `/auth/login?redirect=${encodeURIComponent(
    window.location.pathname + window.location.search,
  )}`;

  return (
    <div className="anmeldung">
      <div className="karte">
        <h1>Belegabrechnung</h1>
        <p>
          Diese Anwendung greift auf Bankbuchungen und Belege zu. Bitte mit dem
          Geschäftskonto anmelden.
        </p>
        <a className="primaer" href={ziel}>
          Mit Microsoft anmelden
        </a>
        <p className="grau klein">
          Die Anmeldung läuft über Microsoft Entra ID. Es wird kein Kennwort in
          dieser Anwendung gespeichert.
        </p>
      </div>
    </div>
  );
}
