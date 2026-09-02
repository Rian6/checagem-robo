# WhatsApp Daily Reaction Bot

Bot para enviar automaticamente uma imagem diária em um grupo do WhatsApp e monitorar reações usando whatsapp-web.js.

## Requisitos

- Node.js 18 ou superior
- WhatsApp no celular
- Grupo existente no WhatsApp

## Instalação

Abra o terminal nesta pasta e execute:

```powershell
npm install
```

## Configuração

Edite `config.json`:

```json
{
  "grupo": "GOJ TEMPLO VIVO",
  "horario_envio": "08:00",
  "pasta_imagens": "imagens",
  "intervalo_reacao": 2000
}
```

## Imagens

Coloque na pasta `imagens`:

- segunda.jpg
- terca.jpg
- quarta.jpg
- quinta.jpg
- sexta.jpg
- sabado.jpg
- domingo.jpg

Também são aceitos `.jpeg`, `.png` e `.webp`.

## Executar

```powershell
npm start
```

Na primeira execução, escaneie o QR Code exibido no terminal.

A sessão será armazenada automaticamente em `sessao_whatsapp`, então normalmente não será necessário escanear novamente.

## Funcionamento

No horário configurado, o bot:

1. Localiza o grupo.
2. Localiza a imagem correspondente ao dia da semana.
3. Envia a imagem diretamente pelo WhatsApp Web.
4. Recebe o objeto da mensagem enviada e seu ID.
5. Monitora as reações dessa mensagem.
6. Exibe no terminal nome, telefone, emoji e horário da reação.

Não utiliza Selenium nem depende de clicar manualmente no botão "Enviar".
