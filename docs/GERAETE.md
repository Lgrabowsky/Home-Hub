# Geräte verbinden

Alle Geräte richtest du in der App unter **Mehr › Geräte & Dienste** ein. Dort steht bei jedem Gerät
in Kurzform, was vorzubereiten ist; hier die ausführliche Fassung. Mit **Verbindung testen** prüfst du
jede Eingabe, bevor du speicherst – der Test sagt in Klartext, was nicht stimmt.

Grundregel: **Lege an jedem Gerät einen eigenen Benutzer für den Hub an.** Dann kann der Hub nur, was
er soll, und du kannst ihm den Zugang jederzeit entziehen, ohne dein eigenes Passwort zu ändern.

---

## myGEKKO

**Am myGEKKO vorbereiten (empfohlen: direkte Verbindung im Heimnetz)**

1. In den Einstellungen des myGEKKO unter „Netzwerk“ die **lokale QueryAPI** einschalten.
2. Dort einen **Benutzer mit Passwort** anlegen, der lesen und schalten darf.
3. Dem myGEKKO im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Gebäude (myGEKKO) › „Im Heimnetz“ › Adresse, Benutzer, Passwort › Verbindung testen ›
einschalten › Speichern.

Alternativ geht die Verbindung **über myGEKKO Plus** (Benutzername, API-Schlüssel und myGEKKO-ID aus
dem Portal live.my-gekko.com). Sie läuft über die Server von myGEKKO, reagiert langsamer und ist in
der Zahl der Abfragen begrenzt – nimm sie nur, wenn die lokale Abfrage nicht möglich ist.

**Was erscheint:** Lichter, Jalousien/Rollläden, Raumregler, Lasten/Steckdosen, Aktionen (als
Szenen), Zeitschaltuhren, Wetterwerte, der Zustand der Alarmanlage – jeweils mit den Namen und
Seiten/Räumen, die am myGEKKO vergeben sind. Benennst du am myGEKKO etwas um, übernimmt die App das.

### Fenster- und Türkontakte

Das ist der eine Punkt, an dem der myGEKKO Grenzen setzt – deshalb ausführlich:

**Was der myGEKKO nach außen gibt.** Über seine Schnittstelle meldet der myGEKKO die
Alarmüberwachung (bei dir „Hülle“) nur als Ganzes: scharf/unscharf, Alarm ja/nein und „mindestens ein
Melder ist offen“. **Welcher** Melder offen ist, verrät die Schnittstelle für die Alarmanlage nicht.
Die App zeigt diesen Gesamtzustand unter **Sicherheit**.

**Wie die App trotzdem jedes Fenster einzeln zeigt.** Einen einzelnen Kontakt kann der Hub lesen,
sobald er am myGEKKO als eigenes Element existiert. Drei Arten erkennt der Hub von selbst (Schalter
„Kontakte automatisch erkennen“):

| Am myGEKKO | Wird in der App zu |
| --- | --- |
| Raumregler mit angeschlossenem Fensterkontakt | „Fenster ‹Raum›“ – sobald der Kontakt einmal als offen gemeldet wurde |
| Zutrittstür (Zutrittskontrolle) | Tür mit ihrem Namen |
| Logik, deren Name oder Seite ein Stichwort enthält (Fenster, Tür, Tor, Kontakt, Magnet, Terrasse, Balkon, Hülle …) | Fenster bzw. Tür mit dem Namen der Logik |

Die Stichwörter kannst du in den Einstellungen anpassen.

**Wenn deine Magnetkontakte nur in der Alarmanlage hängen**, legst du am myGEKKO (oder lässt deinen
Elektriker/Systemintegrator anlegen) **je Kontakt eine Logik** an, die den Eingang des Kontakts
einfach durchreicht – benannt nach dem Fenster, z. B. „Fenster Küche“, auf der Seite des Raums. Das
ist reine Konfiguration am myGEKKO, keine neue Verdrahtung. Danach findet der Hub die Kontakte von
selbst.

**Anlernen – wenn der Hub einen Kontakt nicht von selbst erkennt:**

1. Gebäude (myGEKKO) › Fenster- & Türkontakte › **Kontakt anlernen**.
2. Das betreffende Fenster öffnen und kurz offen lassen.
3. Die App zeigt, welches Element am myGEKKO darauf reagiert hat › **Das ist es** › Namen, Art und
   Raum prüfen › Übernehmen › Speichern.

In der Liste „Eigene Kontakte“ siehst du danach live, ob der Kontakt als offen oder geschlossen
erkannt wird. Zeigt er es verkehrt herum an, stellst du im Kontakt „Offen, wenn der Wert … 0 ist“ um.

---

## DoorBird-Türstationen

**In der DoorBird-App vorbereiten**

1. **Einstellungen › Administration** (mit den Administrator-Zugangsdaten vom „Digital Passport“
   anmelden) › **Benutzer › Hinzufügen**.
2. Dem neuen Benutzer diese **Berechtigungen** geben: „Immer ansehen“, „Verlauf“, „Bewegung“ und
   **„API-Operator“**. Ohne „API-Operator“ kann der Hub nicht auf die Türstation zugreifen.
3. Benutzername (z. B. `abcdef0001`) und Passwort notieren.
4. Der Türstation im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Türstationen (DoorBird) › Türstation hinzufügen › Name, Adresse, Benutzer, Passwort ›
Verbindung testen › Übernehmen › einschalten › Speichern. Für die zweite Türstation genauso.

Sobald die Türstation verbunden ist, kannst du in ihren Einstellungen die **Türöffner benennen**
(„Haustür“, „Garagentor“) und einzelne **ausblenden**, die niemand aus der App schalten soll.

**Was du bekommst:** Live-Video, Gegensprechen, Türöffner mit Schiebe-Bestätigung, Licht,
Klingel-Meldung in der geöffneten App und der **Verlauf**: Der Hub hält jedes Klingeln, jede
Bewegung und jede Türöffnung mit Bild fest und ergänzt beim Start, was die Türstation selbst noch im
Speicher hat. Die Bilder liegen verschlüsselt auf dem Hub und werden nach 90 Tagen gelöscht
(einstellbar).

Gut zu wissen: Eine Türstation erlaubt nur **ein Gespräch zur selben Zeit**. Spricht gerade jemand
über die DoorBird-App, kann der Hub nicht sprechen – und umgekehrt.

---

## Reolink-Kameras

**In der Reolink-App (oder im Browser auf der Kamera) vorbereiten**

1. **Einstellungen › Netzwerk › Erweitert › Server-Einstellungen:** „HTTPS“ (oder „HTTP“) und
   **„RTSP“** einschalten. Bei neueren Kameras sind sie ab Werk aus.
2. Empfohlen: unter **Benutzerverwaltung** einen eigenen Benutzer für den Hub anlegen. Zum
   Schwenken, für Licht und Sirene braucht er Administratorrechte.
3. Der Kamera im Router eine **feste IP-Adresse** zuweisen.

**In der App:** Kameras (Reolink) › Kamera hinzufügen › Name, Adresse, Benutzer, Passwort ›
Verbindung testen › Übernehmen › einschalten › Speichern.

- **Rekorder (NVR) oder Home Hub von Reolink:** dessen Adresse eintragen und unter „Erweitert“ je
  Kamera den **Kanal** wählen (beginnend bei 0) – also pro Kamera ein Eintrag mit derselben Adresse.
- **Akku-Kameras** ohne dauerhafte Netzwerkverbindung (Argus-Reihe u. ä.) bieten keinen Live-Zugriff
  im Heimnetz und funktionieren nur über einen Reolink Home Hub/NVR.

**Was du bekommst:** Live-Video in zwei Qualitäten (HD/SD – unterwegs spart SD Datenvolumen),
Schwenken/Neigen/Zoom und gespeicherte Positionen (bei Kameras, die das können), Mithören,
Scheinwerfer, Sirene.

**Gegensprechen** funktioniert bei Kameras mit Lautsprecher, die Zwei-Wege-Audio über RTSP anbieten
(das sind die meisten aktuellen Modelle mit Lautsprecher). Die App zeigt die Sprechtaste nur, wenn
die Kamera einen Lautsprecher meldet. Bleibt es trotz Taste stumm, unterstützt das Modell diesen Weg
nicht – der Rest funktioniert davon unabhängig.

Bei Bildaussetzern: in den Einstellungen der Kamera unter „Erweitert“ die Videoübertragung von RTSP
auf **FLV** umstellen (dann ohne Gegensprechen).

---

## Sonos-Lautsprecher

**In der Sonos-App vorbereiten**

1. **Konto › Datenschutz & Sicherheit › UPnP** muss eingeschaltet sein (ist es ab Werk). Darüber
   steuert der Hub die Lautsprecher im Heimnetz.
2. Für Musik von Spotify: Spotify in der Sonos-App als Musikdienst hinzufügen (falls noch nicht geschehen).

**In der App:** Lautsprecher (Sonos) › einschalten › Speichern. Der Hub findet die Lautsprecher von
selbst, wenn er im selben Netz hängt. Findet er nichts (getrennte Netze/VLANs), trägst du die
IP-Adresse **eines** Lautsprechers ein – die übrigen ergeben sich daraus.

**Was du bekommst:** alle Räume mit dem, was gerade läuft; Play/Pause/Weiter, Lautstärke je Raum und
je Gruppe, Räume gruppieren und trennen, deine Sonos-Favoriten.

---

## Spotify

Spotify verlangt, dass jede Anwendung als „App“ registriert ist. Das machst du einmalig selbst –
kostenlos, in fünf Minuten. Voraussetzung ist ein **Spotify-Premium-Konto** und dass der Hub über
**https** erreichbar ist (siehe [FERNZUGRIFF.md](FERNZUGRIFF.md)).

1. In der App **Geräte & Dienste › Spotify** öffnen. Dort steht die **Redirect-Adresse** deines Hubs
   zum Kopieren.
2. Auf <https://developer.spotify.com/dashboard> mit deinem Spotify-Konto anmelden › **Create app**.
   - Name und Beschreibung: beliebig (z. B. „Home Hub“)
   - **Redirect URIs:** die kopierte Adresse einfügen
   - **Which API/SDKs are you planning to use:** „Web API“
3. In der neuen App unter **Settings** die **Client ID** kopieren und in Home Hub einfügen
   (ein „Client Secret“ wird nicht gebraucht) › einschalten › Speichern.
4. **Mit Spotify verbinden** antippen, bei Spotify anmelden und zustimmen.

Sollen weitere Spotify-Konten (Familienmitglieder) verknüpft werden können, müssen sie im
Spotify-Dashboard unter **User Management** eingetragen sein. Für den Normalfall – ein Konto für das
Haus – ist nichts weiter nötig.

**Was du bekommst:** Suche, deine Playlists, Alben, Lieblingssongs, zuletzt Gehörtes und Podcasts –
abspielbar auf jedem Lautsprecher bzw. jeder Gruppe. Die Musik selbst läuft direkt vom Lautsprecher
über dessen eigene Spotify-Anbindung; der Hub sagt ihm nur, was er spielen soll.

Gut zu wissen: Spotify verlangt etwa **alle sechs Monate**, die Verbindung zu erneuern. Die App
meldet das rechtzeitig unter Geräte & Dienste; ein Tipp auf „Mit Spotify verbinden“ genügt.

---

## Checkliste für den ersten Einsatz an echten Geräten

Die App wurde gegen Simulatoren entwickelt, die das dokumentierte Verhalten der Geräte nachbilden.
Echte Geräte halten sich nicht immer an ihre Dokumentation. Prüfe deshalb beim ersten Einsatz Schritt
für Schritt – und schau bei Abweichungen unter **Mehr › Diagnose** nach, dort steht je Gerät, was der
Hub sieht:

**myGEKKO**
- [ ] Verbindung testen meldet die erwartete Zahl an Lichtern, Jalousien, Raumreglern.
- [ ] Ein Licht schalten und dimmen; eine Jalousie auf eine Position fahren und stoppen.
- [ ] Sollwert eines Raumreglers ändern; prüfen, ob er am myGEKKO ankommt.
- [ ] Eine Aktion/Szene starten.
- [ ] Fensterkontakte: Stimmt „offen/geschlossen“ für jeden Kontakt? Sonst anlernen (siehe oben).
- [ ] Wird der Zustand der Alarmanlage („Hülle“) richtig angezeigt (scharf/unscharf, etwas offen)?

**DoorBird**
- [ ] Live-Bild erscheint; Gegensprechen in beide Richtungen verständlich.
- [ ] Türöffner: Öffnet das **richtige** Relais? (Zuerst mit einem Relais testen, an dem nichts hängt,
      oder bei offener Tür.)
- [ ] Klingeln: Erscheint die Meldung in der geöffneten App? Steht das Ereignis mit Bild im Verlauf?

**Reolink**
- [ ] Live-Bild in HD und SD; Schwenken stoppt beim Loslassen.
- [ ] Gespeicherte Positionen, Scheinwerfer, Sirene (kurz!).
- [ ] Gegensprechen, sofern die Kamera einen Lautsprecher hat.

**Sonos & Spotify**
- [ ] Alle Lautsprecher erscheinen; Lautstärke und Play/Pause wirken.
- [ ] Zwei Räume gruppieren und wieder trennen.
- [ ] Einen Sonos-Favoriten starten.
- [ ] Einen Titel, ein Album und eine Playlist aus Spotify starten. Startet nichts: in den
      Lautsprecher-Einstellungen die „Spotify-Region“ umstellen und erneut versuchen.

**Von unterwegs** (Mobilfunk statt WLAN)
- [ ] Anmelden, Licht schalten, Live-Bild, Gegensprechen.
