# Sicurezza e privacy

*[English](../en/security.md)*

Cosa sapere per usare il plugin in sicurezza. Il modello delle minacce completo, per sviluppatori e revisori, è in [SECURITY-MODEL.md](../SECURITY-MODEL.md), in inglese.

## Cosa protegge il plugin

- **La password locale del termostato (PswOpen)** è salvata in `<archivio di Homebridge>/much-smarther/pswopen`, leggibile solo dall'utente di Homebridge (permessi 0600, cartella 0700). Non sta in `config.json` e non viene mai scritta nel log.
- **E-mail e password BTicino** servono per una sola richiesta, quando chiedi alla pagina di configurazione di recuperare la password del termostato. Non vengono mai salvate né scritte nel log.
- **Nessuna porta di rete.** Il plugin parla con il termostato sulla rete di casa, e la pagina di configurazione parla con il plugin attraverso un socket locale protetto da una chiave di accesso.
- **Solo comandi sicuri.** Il plugin invia un insieme fisso di comandi con valori controllati: temperatura 7–40 °C, boost da 30, 60 o 90 minuti, spento, programma, stagione. Attraverso il plugin non si può mandare altro al termostato.

## Cosa devi fare tu

1. **Proteggi l'interfaccia di Homebridge.** Alla prima apertura crea un account amministratore con una password robusta. Se la tua versione parte con `admin` / `admin`, cambiala subito.
2. **Non esporre mai Homebridge su internet.** Niente inoltro di porte, niente pubblicazione dell'interfaccia. Fuori casa usa l'app BTicino.
3. **Dai al termostato un indirizzo fisso** sul router, così il plugin lo trova sempre.
4. **Tieni private le copie di backup.** Un backup di Homebridge contiene la password del termostato, le chiavi di abbinamento HomeKit e il codice di abbinamento. Conservalo come una password.
5. **Controlla i log di debug prima di condividerli.** I segreti sono mascherati, ma i log di debug (`-D`) mostrano il traffico del protocollo e dettagli del tuo impianto.
6. **Installa solo plugin di cui ti fidi.** Tutti i plugin di Homebridge girano nello stesso processo e possono leggere i file l'uno dell'altro.

## Limiti che non dipendono dal plugin

- **Il protocollo del termostato non è cifrato** dopo l'accesso. Un dispositivo sulla tua rete potrebbe leggere lo stato o inserire comandi. Tieni il termostato su una rete fidata; ospiti e dispositivi non fidati vanno sulla rete ospiti.
- **L'interfaccia di Homebridge usa HTTP senza cifratura**, se non la configuri diversamente. L'accesso a Homebridge, e la password che scrivi nella pagina di configurazione, passano in chiaro sulla rete. Usala dalla rete di casa, oppure attiva HTTPS nelle impostazioni dell'interfaccia di Homebridge con un tuo certificato.
- **Il recupero della password usa un servizio BTicino non ufficiale.** Potrebbe smettere di funzionare. Inserire la password a mano resta sempre possibile.
- **Un solo client locale alla volta.** Il termostato accetta una sola sessione locale, e la tiene il plugin. Senza internet, l'app BTicino non raggiunge il termostato finché Homebridge è attivo.

## Segnalare un problema

Vedi [SECURITY.md](../../SECURITY.md). Per una vulnerabilità non aprire una issue pubblica.
