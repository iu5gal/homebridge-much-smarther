# Contribuire

*[English](../../CONTRIBUTING.md)*

I contributi di chiunque sono accettati molto volentieri: segnalazioni di problemi, prove su sistemi che non abbiamo potuto provare (**soprattutto Windows, dove è tutto da provare**), correzioni, nuove funzioni nell'ambito del progetto e correzioni delle traduzioni. Questo progetto è stato realizzato con il supporto di Claude, l'assistente di intelligenza artificiale di Anthropic; sono benvenuti anche contributi scritti con strumenti di intelligenza artificiale, purché tu li abbia rivisti e provati e seguano le regole qui sotto.

Grazie dell'aiuto. Questo progetto comanda il riscaldamento di case vere e gira dove le persone tengono dati personali, per cui ha alcune regole ferme. Leggile prima della tua prima modifica. I dettagli tecnici completi sono in [CONTRIBUTING.md](../../CONTRIBUTING.md), in inglese.

Contribuendo, accetti che il tuo contributo sia distribuito con la [licenza MIT](../../LICENSE) del progetto.

## Regole di base

1. **Mai dati personali.** Niente indirizzi IP o MAC del tuo impianto, numeri di serie, nomi di impianti o gateway, indirizzi e-mail, password, codici di abbinamento HomeKit o catture di rete, né nel codice né in test, documentazione, commit, segnalazioni o schermate. Usa valori segnaposto: indirizzi di 192.0.2.0/24 (RFC 5737), `example.com`, password finte come `fake-pin-0000`.
2. **Niente codice da altri progetti senza una licenza compatibile.** In particolare l'integrazione per Home Assistant citata nel README non dichiara alcuna licenza: non copiarne il codice. Il protocollo è implementato a partire da [docs/PROTOCOL.md](../PROTOCOL.md), scritto con parole nostre. Le nuove conoscenze sul protocollo vanno prima lì, con la loro fonte.
3. **Al termostato arrivano solo comandi sicuri.** I nuovi comandi sono operazioni in un elenco chiuso, con intervalli controllati. Nessun passaggio di messaggi grezzi da HomeKit, dalla pagina di configurazione o dalla configurazione.
4. **I problemi di sicurezza si segnalano in privato**: vedi [SECURITY.md](../../SECURITY.md).

## Preparare l'ambiente

Servono Node.js 22, 24 o 26, e [gitleaks](https://github.com/gitleaks/gitleaks).

```sh
npm ci
npm run hooks:install
```

Poi crea la tua **lista personale di valori vietati**, `.git/info/personal-denylist`. Sta dentro `.git`, quindi non viene mai committata, e senza di essa i controlli rifiutano il commit. Mettici i valori che non devono mai lasciare il tuo computer, uno per riga:

```text
# il mio impianto
literal:192.0.2.
exact:nome-del-mio-pi
literal:AA:BB:CC:DD:EE:FF
```

- `literal:` trova il testo ovunque, senza badare a maiuscole e minuscole.
- `exact:` trova solo la parola intera, così `exact:kitchen` non blocca `kitchen-light`.

## Controlli

```sh
npm run check
```

Esegue lint, controllo dei tipi, tutti i test con la copertura (almeno 80 % per `packages/core`), la ricerca di segreti e `npm audit`. Deve passare prima di ogni commit che proponi.

## Provare

- `npm run simulator` avvia un finto termostato su `127.0.0.1:40001`, password `fake-pin-0000`.
- Gli strumenti per un termostato reale (`npm run session`, `npm run files`, `npm run command`, `npm run pswopen`) vanno usati **solo sul tuo**, e solo con Homebridge fermo, perché il termostato accetta una sola sessione locale. `npm run command` **cambia lo stato del termostato**, dopo aver mostrato il comando e chiesto conferma.
- Le catture grezze vanno in `captures/`, che git ignora. I dati dei test devono essere sintetici o ripuliti a mano.

## Traduzioni

La pagina di configurazione e i nomi nell'app Casa vengono da `packages/homebridge-plugin/src/locales/`, un file per lingua, con l'inglese (`en.ts`) come riferimento. Le traduzioni sono state fatte con l'aiuto dell'intelligenza artificiale: le correzioni di chi parla la lingua sono benvenute.

- Mantieni tutte le chiavi e tutti i `{segnaposto}` dell'inglese; i test lo controllano.
- I nomi per l'app Casa (`service.*`) devono seguire la regola di Apple: lettere, numeri, spazi e poca punteggiatura, con una lettera o un numero all'inizio e alla fine.

## Documentazione

L'inglese è la lingua principale e l'italiano è tenuto in parallelo: `README.md` e `README.it.md`, `docs/en/` e `docs/it/`. Una modifica all'una dovrebbe arrivare con l'altra; se non scrivi in italiano, dillo nella pull request e un manutentore ti aiuterà.

## Commit e pull request

- Commit piccoli, ciascuno con una sola modifica, con messaggi nella forma `tipo(ambito): sintesi`, per esempio `fix(core): …`, `docs: …`.
- Aggiungi una riga nella sezione `[Unreleased]` del [CHANGELOG.md](../../CHANGELOG.md) per tutto ciò che un utente noterebbe.
- Nella pull request descrivi cosa hai provato, e su cosa: simulatore, o termostato reale con quale firmware.
