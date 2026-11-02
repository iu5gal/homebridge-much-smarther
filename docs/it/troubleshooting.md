# Risoluzione dei problemi

*[English](../en/troubleshooting.md)*

Parti dal log di Homebridge (**Log** nell'interfaccia di Homebridge). Le righe del plugin cominciano con il nome dell'accessorio, `[Smarther]` se non l'hai cambiato, e sono in inglese.

## Messaggi nel log

| Messaggio nel log | Significato | Cosa fare |
| --- | --- | --- |
| `not configured yet: enter the thermostat address in the plugin settings` | Manca l'indirizzo. | Inseriscilo nella pagina di configurazione e salva ([configurazione](setup.md)). |
| `invalid settings, the plugin is not started: …` | Un'impostazione in `config.json` non è valida; il messaggio dice quale. | Correggila nella pagina di configurazione. Fino ad allora l'accessorio resta nell'app Casa, come "Nessuna risposta". |
| `no thermostat password yet: set it in the plugin settings page` | L'indirizzo c'è, la password no. | Recuperala o scrivila nella pagina di configurazione. |
| `the thermostat rejected the password. It was probably reset: …` | La password è sbagliata, di solito perché il termostato è stato resettato. | Recupera la nuova password nella pagina di configurazione. Il plugin aspetta un minuto tra un tentativo e l'altro per non affaticare il termostato. |
| `connecting to …` poi `authenticated` | Collegato. | Niente. |
| `disconnected: no response within 10000 ms` | Il termostato ha smesso di rispondere: calo del Wi-Fi, mancanza di corrente, riavvio del router. | Niente: il plugin si ricollega da solo, aspettando un po' di più a ogni tentativo, fino a un minuto. |
| `disconnected: socket error: connect EHOSTUNREACH …`, `ENETUNREACH`, `ETIMEDOUT` | L'indirizzo non è raggiungibile. | Se dura: controlla che il termostato sia sul suo Wi-Fi e che il suo indirizzo non sia cambiato. Dagli un indirizzo fisso sul router. |
| `disconnected: socket error: connect ECONNREFUSED …` | A quell'indirizzo risponde qualcosa, ma non il termostato. | Controlla indirizzo e porta (di solito 40000). |
| `disconnected: connection closed by the thermostat` | Il termostato ha rifiutato la sessione, perché la tiene un altro client locale, o perché dopo un calo di rete tiene ancora quella precedente. | Di solito passa al tentativo successivo. Se dura: un'altra istanza di Homebridge o un altro strumento è collegato al termostato. Fermalo: il termostato accetta un solo client locale. |
| `the thermostat is busy: retrying the command once` | Il termostato ha chiesto di aspettare. | Niente, a meno che i comandi non falliscano. |
| `command failed: …` | Un comando non è stato accettato, o la connessione è caduta mentre lo inviava. | Riprova; controlla lo stato nell'app BTicino. |
| `the thermostat reports its temperature as not valid` | Il termostato segnala la misura del sensore come non valida. | L'app Casa mostra un guasto. Se dura, controlla il termostato. |
| `the password file was readable by others: its permissions are now 0600` | Il file della password aveva permessi più larghi, per esempio dopo un ripristino. | Niente: sistemato. |
| `the setup page cannot reach the plugin: …` | Non si è potuto aprire il socket locale per la pagina di configurazione. | Riavvia Homebridge. Se continua, controlla che la cartella dei dati di Homebridge appartenga all'utente di Homebridge. |

## Nell'app Casa

**"Nessuna risposta".** Il termostato è irraggiungibile da più di un minuto, oppure la password manca o è rifiutata, oppure le impostazioni non sono valide. Il log dice quale dei casi.

**Durante l'abbinamento il bridge non si trova.** iPhone e Homebridge devono stare sulla stessa rete e vedersi con Bonjour (mDNS). Disattiva l'isolamento dei client e i filtri multicast sugli access point Wi-Fi. Controlla nell'interfaccia di Homebridge che Homebridge sia in esecuzione.

**Un servizio si chiama "Interruttore 2" o simile.** Riavvia Homebridge: il plugin rimette i suoi nomi a ogni avvio.

**La temperatura che imposto più tardi torna al programma.** È il comportamento predefinito, come nell'app BTicino: una temperatura manuale dura fino al prossimo cambio di livello del programma. Nelle opzioni puoi scegliere "fino a nuovo comando" o un tempo fisso.

**L'app Casa mostra "Caldo", non "manuale".** È il modo in cui l'app Casa mostra il manuale del termostato: non ha altre scelte. Vedi [funzioni](features.md).

**Compaiono due termostati.** È ancora abbinato un vecchio bridge. Rimuovilo dall'app Casa ([abbinamento](pairing.md#sostituire-un-bridge)).

## Nella pagina di configurazione

**"Il plugin non è in esecuzione."** Homebridge è fermo o si sta ancora avviando, oppure il plugin è disattivato, oppure gira in un bridge figlio fermo. Avvia Homebridge e riapri la pagina.

**"Il termostato non è collegato."** I comandi hanno bisogno del collegamento: vedi i messaggi del log qui sopra.

**"Questa scelta è scaduta."** I termostati trovati sull'account BTicino si possono scegliere per cinque minuti. Accedi di nuovo.

Per i messaggi dell'accesso BTicino, vedi la [configurazione](setup.md#accedi-con-laccount-bticino-consigliato).

## L'app BTicino

**L'app BTicino non funziona in casa senza internet.** È previsto: il termostato accetta un solo client locale, e lo tiene il plugin. Con internet l'app funziona attraverso il cloud come sempre.

## Chiedere aiuto

Quando apri una segnalazione, indica le versioni del plugin, di Homebridge e di Node.js, e le righe del plugin nel log. Un log di debug (modo debug di Homebridge, `-D`) aiuta, ma **controllalo prima**: i segreti sono mascherati, ma mostra il traffico del protocollo e dettagli del tuo impianto. Non pubblicare mai la password, le credenziali BTicino, il codice di abbinamento HomeKit o gli indirizzi della tua rete; sostituiscili con valori segnaposto.
