# 3D-Haus (Labs)

Das Haus als 3D-Modell: drehen, hineinzoomen, Geschosse öffnen und Geräte direkt an ihrer Stelle
bedienen. Das Licht folgt der echten Tageszeit, Sonne und Schatten stehen so, wie sie draußen gerade
stehen, abends leuchten die eingeschalteten Lampen.

Das 3D-Haus ist eine **Testfunktion (Labs)**. Sie ist ausgeschaltet, bis du sie auf einem Gerät
einschaltest, und lässt den Rest der App unverändert.

## Einschalten

**Mehr › Einstellungen › Labs › 3D-Haus**. Der Schalter gilt nur für das Gerät, auf dem du ihn
umlegst. Danach findest du das 3D-Haus unter **Mehr › 3D-Haus** und unter **Räume** oben rechts (**3D**).

## Modell vorbereiten

Der Hub liest **IFC-Dateien** (IFC 2x3 und IFC 4), das offene Austauschformat für Gebäudemodelle.

| Programm | Export |
| --- | --- |
| ArchiCAD | Datei › Speichern unter › IFC (Übersetzer z. B. „Coordination View“ oder „Reference View“) |
| cadwork | Datei › Export › IFC |
| Revit | Datei › Exportieren › IFC |
| Vectorworks, Allplan, SketchUp … | IFC-Export des Programms |

**BIMx-Dateien gehen nicht** – BIMx ist ein geschlossenes Format zum Anschauen. Wer das Modell nur als
BIMx hat, bittet den Architekten um einen IFC-Export aus ArchiCAD.

Damit die Geschosse erkannt werden, braucht das Modell Geschoss-Namen – entweder als Geschosse
(IfcBuildingStorey) oder in den Namen der CAD-Layer bzw. Ebenen, z. B. „KG Wände“, „EG Decke“,
„OG 1 Wände“, „DG Wände“. Verstanden werden KG/UG/Keller, EG/Erdgeschoss, OG/1.OG/OG 2/Obergeschoss,
DG/Dachgeschoss und Spitzboden. Teile auf einem Layer „Dach“ bilden das Dach; „Carport“, „Garage“,
„Terrasse“, „Garten“ & Co. den Außenbereich. Decken gehören zum Geschoss, dessen Boden sie sind.

## Hochladen

**Einstellungen › Verwaltung › 3D-Haus › IFC-Datei hochladen** (nur Administratoren, bis 80 MB).
Der Hub wandelt das Modell einmal um (ein paar Sekunden) und zeigt, was er erkannt hat: Bauteile,
Geschosse, Hinweise auf ausgelassene Teile. Ein überarbeitetes Modell lädst du einfach erneut hoch –
platzierte Geräte bleiben an ihrer Stelle.

**Datenschutz:** Das Modell verlässt deinen Hub nicht. Die IFC-Datei und das umgewandelte Modell
liegen verschlüsselt (mit dem Hauptschlüssel des Hubs) im Datenordner unter `house3d/`, Standort und
Einstellungen verschlüsselt in der Datenbank. Die Apps laden nur das umgewandelte Modell und nur mit
gültiger Anmeldung. Der Sonnenstand wird auf dem Gerät berechnet, ohne Online-Dienst. Wer den
Datenordner sichert, sichert das Modell mit.

## Einrichten

Auf derselben Seite:

- **Sonne:** Breiten- und Längengrad des Hauses (zwei Nachkommastellen genügen, z. B. aus einer
  Karten-App) und wo Norden ist. Norden ist der Winkel im Uhrzeigersinn von der „oberen“ Kante des
  Plans bis Norden; wenn das Modell selbst eine Nordrichtung enthält, steht sie als Hinweis dabei.
  Stimmt die Richtung, fallen die Schatten so wie draußen.
- **Geschosse:** eigene Namen, z. B. „Wohnebene“ statt „Erdgeschoss“.
- **Farben:** CAD-Programme färben nach Bauteilart (Stützen blau, Platten grün …). Der Hub wählt
  stattdessen Farben nach Material – Holz, Putz, Beton, Glas, Stahl, Dach. Hier passt du sie an euer
  echtes Haus an, z. B. die Farbe der Fassade oder der Dacheindeckung.

## Geräte platzieren

Das Modell kennt die Geräte nicht – du zeigst einmal, wo sie sitzen: im 3D-Haus **Geräte
platzieren** (unter dem Modell) › Gerät wählen › im Modell auf die Stelle tippen. Öffne dafür vorher
das passende Geschoss. Am einfachsten zoomst du dazu nah heran. **Versetzen** und das Papierkorb-Symbol
in derselben Liste ändern oder entfernen eine Position.

## Bedienen

| | |
| --- | --- |
| Ein Finger seitlich wischen | dreht das Haus – die Vorderseite folgt dem Finger; mit Schwung läuft es aus |
| Ein Finger hoch/runter | neigt die Ansicht (über die Grenze hinaus federt sie zurück) |
| Zwei Finger auseinander/zusammen | zoomt – vom ganzen Haus über das geöffnete Haus bis ins Geschoss und weiter bis an die Wand |
| Zwei Finger verdrehen / gemeinsam schieben | dreht / verschiebt |
| Antippen | im geöffneten Haus: dieses Geschoss öffnen; im Geschoss: näher heran |
| Gerät antippen | Steuerung des Geräts |
| Leiste rechts oben | direkt zu einem Geschoss |
| Kompass | zurück zur Ausgangsansicht |
| Regler unten links | eine andere Tageszeit ansehen (**Jetzt** kehrt zur echten Zeit zurück) |
| Maus / Trackpad / Tastatur | ziehen dreht (rechte Maustaste oder Umschalt verschiebt), Mausrad zoomt zur Zeigerposition, Pfeiltasten drehen und neigen, + und − zoomen |

## Grenzen der Testversion

- Öffnungen, die im Modell als Ausschnitt gerechnet werden (Fenster- und Türöffnungen in
  ArchiCAD/Revit-Wänden), erscheinen geschlossen; Fenster und Türen selbst werden gezeigt.
  cadwork-Modelle sind davon nicht betroffen.
- Räume (IfcSpace) werden noch nicht ausgewertet; Geräte gehören über ihre Position zu einem Geschoss.
- Ältere oder sehr einfache Handys können bei großen Modellen ruckeln.
