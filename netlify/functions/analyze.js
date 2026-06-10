// Netlify Function — leitet Anfragen sicher an die Anthropic-API weiter.
//
// Der API-Key liegt als Umgebungsvariable ANTHROPIC_API_KEY auf Netlify und
// wird NIE an den Browser geschickt. Besucher der App brauchen keinen eigenen
// Key — du zahlst alle Analysen.
//
// Bewusste Entscheidung: kein @anthropic-ai/sdk, sondern fetch() pur — damit
// das Drag-and-Drop-Deploy ohne npm install funktioniert. Node 18+ (Netlify-
// Standard) hat fetch eingebaut.

const SYSTEM_PROMPT = `Du bist ein erfahrener deutscher Handwerker-Experte. Antworte auf Deutsch in GENAU diesem Format. Halte dich kurz und praktisch.

ERLAUBTES MARKDOWN:
- **Fettdruck** für Schlüsselbegriffe (Bauteile, Marken, Aktionen, Beträge wie **80–150 €**)
- Aufzählungen mit "- " am Zeilenanfang (Punkt 2 bei DIY-Schritten, Punkt 4 immer)

VERBOTEN:
- Markdown-Überschriften (kein #, ##, ###)
- Trennlinien (kein ---)
- Titelzeile vor "1."
- Code-Blöcke (kein \`\`\`)

WICHTIG für Listen: Vor einer Liste mit "- " IMMER eine Leerzeile lassen, sonst wird sie nicht als Liste gerendert. Zwischen Listen-Punkten KEINE Leerzeile.

FORMAT (genau so, Zeile für Zeile):

1. <Was ist das Problem wahrscheinlich. Kurzer Fließtext, 2–4 Sätze. Gerne **fett** für die wahrscheinliche Ursache.>

2. <Ob man es selbst lösen kann. Beginne mit **Ja**, **Nein** oder **Teilweise** und begründe kurz. Bei DIY-Schritten Liste mit Leerzeile davor.>

3. <Ungefähre Kosten für den Handwerker in der genannten Stadt. Beachte: Großstädte (München, Hamburg, Frankfurt, Stuttgart, Berlin) +20–30 %, Süddeutschland teurer als Norddeutschland, ländlich günstiger. Konkrete Zahlen in Euro fett markieren, kurz regionale Einordnung.>

4. <Welche Fragen man dem Handwerker stellen sollte. Liste mit Leerzeile davor, 3–5 Punkte mit Bindestrich.>

Handwerker-Typ: <Berufsbezeichnung>

DIE LETZTE ZEILE "Handwerker-Typ:" IST PFLICHT und muss immer ganz am Ende stehen, OHNE jegliche Formatierung — kein Fettdruck, keine Sternchen um den Beruf, keine Klammern. <Berufsbezeichnung> ist EIN deutsches Berufswort, z.B.: Klempner, Elektriker, Dachdecker, SHK-Techniker, Heizungsbauer, Fliesenleger, Maler, Schreiner, Tischler, Glaser, Schlosser, Garten- und Landschaftsbauer, Rohrreinigung.

BEISPIEL (lerne von diesem Stil — beachte die Leerzeilen vor den Listen):

1. Der Wasserhahn tropft wahrscheinlich, weil die **Kartusche oder Dichtung im Auslauf** verschlissen ist. Das ist eine der häufigsten Ursachen bei tropfenden Mischbatterien.

2. **Ja**, mit handwerklichem Geschick selbst machbar. Vorgehen:

- **Wasserzufuhr** unterm Waschbecken zudrehen
- Mischer-Kappe abnehmen
- **Kartusche tauschen** (kostet **10–30 €** im Baumarkt)

Wer unsicher ist, ruft den Handwerker.

3. In Oldenburg eher günstig: Anfahrt + Diagnose **50–80 €**, Kartuschentausch **80–150 €** inkl. Material. Großstädte etwa 20 % teurer.

4. Sinnvolle Fragen:

- Welche Marke ist die Mischbatterie?
- Hast du die passende Kartusche dabei oder müssen wir bestellen?
- Ist die Reparatur sinnvoll oder lohnt ein Neuteil?
- Gibt es Garantie auf die Arbeit?

Handwerker-Typ: Klempner`;

const MAX_TEXT_LENGTH = 2000;
const MAX_CITY_LENGTH = 100;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Methode nicht erlaubt.' });
  }

  // Body parsen
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Ungültige Anfrage.' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const city = typeof payload.city === 'string' ? payload.city.trim() : '';

  // Eingaben validieren
  if (!text) {
    return jsonResponse(400, { error: 'Problem-Beschreibung fehlt.' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse(413, {
      error: `Problem-Beschreibung zu lang (max. ${MAX_TEXT_LENGTH} Zeichen).`
    });
  }
  if (city.length > MAX_CITY_LENGTH) {
    return jsonResponse(413, { error: 'Stadt-Eingabe zu lang.' });
  }

  // API-Key aus Umgebungsvariable
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY ist nicht gesetzt');
    return jsonResponse(500, {
      error: 'Server-Konfiguration fehlt. Bitte später erneut versuchen.'
    });
  }

  const userContent = city
    ? `Meine Stadt: ${city}\n\nProblem: ${text}`
    : `Problem: ${text}`;

  // Anthropic API aufrufen
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API Fehler', response.status, errorBody);

      // Fehler für Client aufbereiten — KEINE internen Details rausgeben
      if (response.status === 429) {
        return jsonResponse(429, {
          error: 'Aktuell zu viele Anfragen. Bitte einen Moment warten und erneut versuchen.'
        });
      }
      if (response.status === 401 || response.status === 403) {
        return jsonResponse(500, {
          error: 'Server-Konfiguration fehlerhaft. Bitte später erneut versuchen.'
        });
      }
      if (response.status >= 500) {
        return jsonResponse(502, {
          error: 'KI-Dienst ist gerade nicht erreichbar. Bitte später erneut versuchen.'
        });
      }
      return jsonResponse(500, {
        error: 'Analyse fehlgeschlagen. Bitte später erneut versuchen.'
      });
    }

    const data = await response.json();
    const answer = data && data.content && data.content[0] && data.content[0].text;

    if (!answer) {
      console.error('Keine verwertbare Antwort von Anthropic', data);
      return jsonResponse(500, {
        error: 'Keine verwertbare Antwort erhalten. Bitte erneut versuchen.'
      });
    }

    return jsonResponse(200, { answer });
  } catch (err) {
    console.error('Function-Fehler', err);
    return jsonResponse(502, {
      error: 'Verbindung zum KI-Server fehlgeschlagen. Bitte später erneut versuchen.'
    });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
