# Note sul protocollo

*[English: full specification](../PROTOCOL.md)*

Una sintesi del protocollo locale del termostato, per chi vuole capire come funziona il plugin. La specifica completa, con la provenienza di ogni affermazione e tutti i dettagli, è in [PROTOCOL.md](../PROTOCOL.md), in inglese: la libreria in `packages/core` è scritta a partire da quella.

## Trasporto

- **TCP sulla porta 40000** dell'indirizzo del termostato, sulla rete di casa. Niente TLS.
- La connessione resta aperta: il termostato vi invia da solo ogni cambio di stato.
- **Una sola sessione locale alla volta.** Con una sessione aperta, il termostato chiude subito ogni altra connessione. Per questo il plugin e altri strumenti locali non possono stare collegati insieme.
- L'app BTicino parla con il termostato attraverso il cloud BTicino, anche in casa.

## Messaggi

Il flusso contiene due tipi di messaggi, uno dopo l'altro:

- brevi messaggi di testo OpenWebNet, come `*#*1##`, che il termostato invia appena si apre la connessione;
- documenti XML `<OWNMsg Profile="V3">`, con un tipo (`GET`, `SET`, `RSP`, `EVT`), un identificativo che lega domanda e risposta, un'azione (per esempio `device_state`) e un elenco di parametri.

I valori sono testo semplice: numeri con il punto (`21.5`), `TRUE` / `FALSE`, date e ore locali senza fuso.

## Accesso

Subito dopo l'apertura della connessione:

1. il client chiede la versione 3 del protocollo, con comandi ed eventi;
2. il termostato invia un numero casuale;
3. il client risponde con un altro numero casuale e un'impronta SHA-256 calcolata dai due numeri e dalla password locale (PswOpen);
4. il termostato risponde con la sua impronta, che il client verifica: così anche un falso termostato, che non conosce la password, viene scoperto.

La password non viaggia mai sulla rete. Però chi cattura questo scambio può provare a indovinarla fuori linea: le catture di rete vanno trattate come segreti. Dopo l'accesso **niente è firmato né cifrato**: è una proprietà del termostato, fuori dal nostro controllo.

## Comandi

- `GET device_state` legge lo stato.
- `SET device_state` lo cambia: stagione (`HEATING` / `COOLING`), modo (`AUTOMATIC`, `MANUAL`, `BOOST`, `PROTECTION`), temperatura, programma e una finestra di validità con inizio e fine. La fine del manuale e dello spento può arrivare fino a 10 giorni dopo; il boost dura 30, 60 o 90 minuti.
- `GET device_keep_alive`, ogni 10 secondi, controlla che la connessione sia viva.
- `GET device_diagnostic` legge firmware e stato dei sensori; `GET device_file` legge il file di configurazione e i file dei programmi.

Il termostato risponde con `AckMsg` o `NackMsg`. Le ore delle finestre sono nell'ora locale del termostato.

## Stato ed eventi

Il termostato invia un evento `EVT device_state` a ogni cambiamento, sempre con lo stato completo:

- stagione, modo, temperatura impostata, programma attivo;
- temperatura e umidità della stanza, con un indicatore di validità;
- se la caldaia (o il raffrescamento) è comandata in quel momento;
- la finestra di validità del modo attuale;
- l'ora del termostato con il suo fuso, e il suo indirizzo.

Spesso lo stesso evento arriva due volte. Ne arrivano anche per i soli cambi di temperatura e umidità, ogni pochi minuti, per cui non serve interrogare il termostato di continuo.

Le impostazioni (livelli di temperatura, isteresi, calibrazione, temperature di protezione) **non** producono eventi: il plugin le rilegge dal file di configurazione ogni tanto.

## Dati personali

Il file di configurazione del termostato contiene anche **nome e password della rete Wi-Fi**, il nome dell'impianto, il MAC del router, il fuso orario e le coordinate. Il plugin non legge quei campi e non scrive mai nel log il contenuto dei file.

## Recupero della password dal cloud

La password locale si recupera una volta dall'account BTicino, attraverso un servizio **non ufficiale** del cloud usato dall'app: un accesso con e-mail e password, poi l'elenco degli impianti con i loro termostati e le loro password. Il collegamento usa HTTPS con la normale verifica del certificato. I dettagli sono in [PROTOCOL.md §8](../PROTOCOL.md#8-retrieving-the-pswopen-from-the-cloud).
