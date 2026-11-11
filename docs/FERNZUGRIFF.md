# Zugriff von unterwegs

Die App spricht immer mit deinem Hub zu Hause. Damit das auch von unterwegs klappt, braucht der Hub
einen Namen, unter dem ihn deine Geräte erreichen – und zwar **verschlüsselt (https)**. Ohne https
verweigern Browser und Android das Mikrofon, und Spotify lässt sich nicht verknüpfen.

Es gibt zwei gute Wege. Beide erfüllen „befugte Personen von überall, Unbefugte gar nicht“:

| | **A – Privates Netz (VPN)** | **B – Eigene Adresse im Internet** |
| --- | --- | --- |
| Erreichbar für | nur Geräte, die du in dein privates Netz aufgenommen hast | jeden, der die Adresse kennt – geschützt durch Anmeldung und zweiten Faktor |
| Router-Einstellungen | keine | Portfreigaben nötig |
| Auf jedem Handy nötig | VPN-App (einmal einrichten, läuft dann im Hintergrund) | nichts außer der Home-Hub-App |
| Angriffsfläche | praktisch keine: der Hub ist aus dem Internet unsichtbar | die Anmeldeseite ist aus dem Internet sichtbar |
| Funktioniert auch bei Glasfaser/DS-Lite/Mobilfunk ohne eigene IPv4-Adresse | ja | meist nicht |

**Empfehlung: Weg A.** Er ist sicherer und einfacher. Weg B ist sinnvoll, wenn Gäste oder
Familienmitglieder keine VPN-App installieren sollen.

---

## Weg A – Privates Netz mit Tailscale

[Tailscale](https://tailscale.com) verbindet deine Geräte zu einem privaten Netz, ohne dass du am
Router etwas öffnen musst. Für den privaten Gebrauch ist es kostenlos. (Jedes andere VPN, z. B.
WireGuard auf der FRITZ!Box, geht grundsätzlich auch – du brauchst dann aber selbst ein gültiges
https-Zertifikat für den Hub.)

1. **Tailscale auf dem Hub-Rechner installieren** und anmelden:
   <https://tailscale.com/download/linux>
2. In der Tailscale-Verwaltung unter **DNS** „MagicDNS“ und „HTTPS Certificates“ einschalten.
   Dein Rechner bekommt einen Namen wie `rechner.mein-netz.ts.net`.
3. **https einschalten** – Tailscale übernimmt Zertifikat und Weiterleitung:

   ```bash
   sudo tailscale serve --bg 8080
   ```

4. In `deploy/.env` eintragen: `HUB_DOMAIN=rechner.mein-netz.ts.net`, `HUB_WEBRTC_CANDIDATES` leer
   lassen. Den mitgelieferten Proxy brauchst du auf diesem Weg nicht – starte nur den Hub:

   ```bash
   docker compose up -d --build hub
   ```

5. **Tailscale-App auf jedem Handy/Tablet/PC** installieren und im selben Netz anmelden (oder die
   Person in dein Netz einladen bzw. nur den Hub-Rechner mit ihr teilen).
6. In der Home-Hub-App bzw. im Browser `https://rechner.mein-netz.ts.net` öffnen.

Zu Hause und unterwegs gilt dieselbe Adresse; zu Hause laufen die Daten direkt durchs WLAN.

Falls von unterwegs kein Live-Bild erscheint: Trage in `.env`
`HUB_WEBRTC_CANDIDATES=<Tailscale-IP des Hub-Rechners>:8555` ein (die Adresse beginnt mit `100.` und
steht in der Tailscale-App) und starte den Hub neu.

---

## Weg B – Eigene Adresse im Internet

Du brauchst:

1. **Einen Namen, der auf deinen Internetanschluss zeigt.** Entweder eine eigene (Sub-)Domain mit
   DynDNS oder den kostenlosen Namen deines Routers (bei der FRITZ!Box: MyFRITZ!-Adresse,
   `….myfritz.net`).
2. **Eine öffentliche IPv4-Adresse.** Bei Anschlüssen mit „DS-Lite“ oder „CG-NAT“ (viele Glasfaser-
   und Kabelanschlüsse, Mobilfunk) kommen Verbindungen von außen nicht bei dir an → nimm Weg A.
3. **Portfreigaben im Router** auf den Hub-Rechner:

   | Port | Protokoll | Wofür |
   | --- | --- | --- |
   | 443 | TCP | die App (https) |
   | 80 | TCP | nur für das automatische Ausstellen und Erneuern des Zertifikats |
   | 8555 | TCP **und** UDP | Live-Video und Gegensprechen |

4. In `deploy/.env`:

   ```
   HUB_DOMAIN=zuhause.example.de
   HUB_WEBRTC_CANDIDATES=zuhause.example.de:8555
   ```

5. `docker compose up -d --build` – der mitgelieferte Proxy (Caddy) holt sich das Zertifikat von
   Let's Encrypt selbst und erneuert es automatisch.

Was Fremde dann sehen: eine Anmeldeseite. Dahinter kommt niemand ohne Passwort **und** zweiten
Faktor; wiederholte Fehlversuche werden gebremst und protokolliert (siehe
[SICHERHEIT.md](SICHERHEIT.md)). Halte den Hub aktuell und lass die Zwei-Faktor-Pflicht eingeschaltet.

---

## Live-Video und Gegensprechen

Bild und Ton laufen nicht über https, sondern – wie bei jeder Videotelefonie – über eine eigene,
verschlüsselte Direktverbindung zum **Medien-Port 8555** des Hubs. Erst nach der Anmeldung verrät der
Hub einer App, wie sie diese Verbindung aufbaut; ohne gültige Sitzung liefert der Port nichts.

- Ist der Medien-Port erreichbar (immer bei Weg A, mit Portfreigabe bei Weg B): Video mit sehr
  geringer Verzögerung, Mithören und Gegensprechen.
- Ist er nicht erreichbar (z. B. Firmen-WLAN, das nur Web-Verkehr durchlässt): Die App schaltet von
  selbst auf Übertragung über die https-Verbindung um. Das Bild kommt dann mit etwa ein bis zwei
  Sekunden Verzögerung; **Gegensprechen ist in diesem Fall nicht möglich.**

Der Hub kontaktiert dafür keine fremden Server (kein STUN/TURN). Wer in schwierigen Netzen trotzdem
Gegensprechen braucht, kann einen eigenen TURN-Server über `HUB_WEBRTC_ICE_SERVERS` angeben.

---

## Die Android-App verbinden

Beim ersten Start fragt die App nach der Adresse des Hubs: `https://` + dein `HUB_DOMAIN`. Mehr dazu
in [ANDROID.md](ANDROID.md).
