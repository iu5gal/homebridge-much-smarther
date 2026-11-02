# Installazione su Raspberry Pi

*[English](../en/installation.md)*

Questa guida installa Homebridge dai suoi pacchetti Debian ufficiali, poi il plugin. È stata seguita su un Raspberry Pi 3 con 1 GB di RAM e Raspberry Pi OS a 64 bit (Debian 13), con altri servizi già attivi. Su altri sistemi Debian o Ubuntu si procede allo stesso modo.

Passi successivi: [configurazione](setup.md), poi [abbinamento con l'app Casa](pairing.md).

## Cosa serve

- Un termostato BTicino Smarther **X8000** (prima generazione, non il successivo Smarther2 with Netatmo), già configurato con l'app BTicino Thermostat e collegato al Wi-Fi di casa.
- Un Raspberry Pi, o un altro computer Linux sempre acceso, sulla stessa rete.
- Un iPhone o un iPad con l'app Casa, sulla stessa rete.
- Per recuperare la password del termostato: e-mail e password dell'account BTicino a cui appartiene il termostato. In alternativa, la password stessa, se la conosci già.

## 1. Prepara la rete

1. **Dai al termostato un indirizzo fisso** sul router (una prenotazione DHCP). Il plugin si collega a quell'indirizzo. Fai lo stesso per il Raspberry Pi.
2. **Fai in modo che i dispositivi si vedano.** L'app Casa trova Homebridge con Bonjour (mDNS). Sugli access point Wi-Fi tieni disattivati l'isolamento dei client e i filtri multicast per la rete di casa.
3. **Non aprire nessuna porta** sul router: niente di tutto questo deve essere raggiungibile da internet.

## 2. Installa Homebridge

Segui la guida ufficiale, [Install Homebridge on Debian or Ubuntu Linux](https://github.com/homebridge/homebridge/wiki/Install-Homebridge-on-Debian-or-Ubuntu-Linux), in inglese. Nel momento in cui scriviamo si riduce a:

```sh
sudo apt-get update
sudo apt-get install -y curl gpg
curl -sSfL https://repo.homebridge.io/KEY.gpg | sudo gpg --dearmor | sudo tee /usr/share/keyrings/homebridge.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/homebridge.gpg] https://repo.homebridge.io stable main" | sudo tee /etc/apt/sources.list.d/homebridge.list > /dev/null
sudo apt-get update
sudo apt-get install homebridge
```

Il pacchetto:

- porta con sé il proprio Node.js in `/opt/homebridge` e non tocca un eventuale altro Node.js;
- fa girare Homebridge come utente `homebridge`, con il servizio systemd `homebridge`, avviato all'accensione;
- tiene i suoi dati in `/var/lib/homebridge`;
- offre l'interfaccia di Homebridge sulla porta 8581.

Poi apri `http://<indirizzo-del-pi>:8581` nel browser, per esempio `http://192.0.2.20:8581`.

**Alla prima apertura crea l'account amministratore** con una password robusta. Se la tua versione parte con utente `admin` e password `admin`, cambiali subito.

## 3. Installa il plugin

### Dall'interfaccia di Homebridge

Quando il plugin sarà pubblicato su npm: nell'interfaccia di Homebridge apri **Plugin**, cerca `homebridge-much-smarther` e installalo. Homebridge chiede di riavviarsi.

### Da un file di pacchetto

Finché il plugin non è su npm, scarica `homebridge-much-smarther-<versione>.tgz` dalla [pagina delle versioni](https://github.com/iu5gal/much-smarther-bridge/releases). Copialo sul Pi, per esempio con `scp`, poi sul Pi:

```sh
sudo install -d -o homebridge -g homebridge /var/lib/homebridge/local-packages
sudo install -o homebridge -g homebridge -m 0644 homebridge-much-smarther-<versione>.tgz /var/lib/homebridge/local-packages/
cd /var/lib/homebridge
sudo -u homebridge env PATH=/opt/homebridge/bin:/usr/bin:/bin HOME=/var/lib/homebridge \
  npm --prefix /var/lib/homebridge install --ignore-scripts ./local-packages/homebridge-much-smarther-<versione>.tgz
sudo systemctl restart homebridge
```

- Il file resta in `local-packages`: npm ne registra il percorso e le installazioni successive ne hanno bisogno.
- `--ignore-scripts` è una precauzione; il pacchetto non ha script di installazione.
- Il comando usa il Node.js e l'npm di Homebridge, come utente `homebridge`, così i file appartengono a lui.

### Bridge principale o bridge figlio

Tieni il plugin nel **bridge principale**, che è l'impostazione predefinita. Un bridge figlio è un processo separato e occupa altra memoria, cosa che su un Pi da 1 GB conta.

## 4. Verifica

Nell'interfaccia di Homebridge apri **Log**. Dopo il riavvio dovresti vedere:

```text
[Smarther] not configured yet: enter the thermostat address in the plugin settings
```

È normale: prosegui con la [configurazione](setup.md). I messaggi del log sono in inglese.

## Risorse

Misurate su un Raspberry Pi 3 (1 GB), Homebridge 2.5 dal pacchetto Debian, con solo questo plugin:

| Cosa | Valore |
| --- | --- |
| Memoria occupata da Homebridge e dalla sua interfaccia | circa 125 MiB di memoria disponibile |
| Memoria aggiunta dal plugin | circa 10–15 MiB in più |
| Memoria residente, a regime | Homebridge con il plugin circa 105 MB, servizio dell'interfaccia circa 155 MB (entrambi comprendono memoria condivisa) |
| Con la pagina di configurazione aperta | un processo in più da circa 70 MB, che termina quando chiudi la pagina |
| Dopo 23 ore | invariata: nessuna crescita |

| Evento | Plugin di nuovo collegato dopo |
| --- | --- |
| Riavvio di Homebridge | circa 15 s |
| Riavvio del Raspberry Pi | circa 1 minuto e mezzo dal comando di riavvio |
| Riavvio del router | circa 30 s dal ritorno della rete |

Il plugin si accorge di una connessione persa entro 10 s. L'app Casa mostra "Nessuna risposta" solo se il termostato resta irraggiungibile per più di un minuto.

## Aggiornamento

- Dall'interfaccia di Homebridge: **Plugin**, poi aggiorna.
- Da un file di pacchetto: copia il nuovo file ed esegui lo stesso comando `npm install` con il nuovo nome, poi riavvia Homebridge. Dopo puoi cancellare il vecchio file da `local-packages`.

## Disinstallazione

1. Rimuovi il bridge dall'app Casa, se non usi più Homebridge.
2. Disinstalla il plugin dall'interfaccia di Homebridge, oppure con `npm --prefix /var/lib/homebridge uninstall homebridge-much-smarther`, eseguito come il comando di installazione qui sopra.
3. Cancella `/var/lib/homebridge/much-smarther`, che contiene la password del termostato.

Per togliere anche Homebridge: `sudo apt-get remove homebridge`, poi cancella `/var/lib/homebridge`, che contiene le chiavi di abbinamento e i backup.
