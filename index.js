const fetch = 				require('node-fetch');
const XLSX = 				require('xlsx');
const { URLSearchParams } = require('url');
const fs =					require('fs');
const _ =					require('lodash');
const TelegramBot = 		require('node-telegram-bot-api');

const trainSearchUrl = "https://booking.uz.gov.ua/train_search/";
const OdessaStationId = "2208001";
const LvivStationId = "2218000";
const HOUR_IN_MILISECONDS = 60 * 60 * 1000;
const POLL_RESULTS_FILE_NAME = 'C:\\TestFolder\\TestWB.xlsx';

let areNotificationsAllowed = true;
let workbook, bot;

const settingsFile = fs.readFileSync("settings.json", "utf8");
const settings = JSON.parse(settingsFile);
const {token, CHAT_ID: chatId} = settings;

function initializeTelegramBot() {
	
	bot = new TelegramBot(token, {polling: true});

	bot.onText(/^\/(.+)$/, (msg, match) => {
		console.log('Received message', msg);
		if (match[1] === "stop") {
			areNotificationsAllowed = false;
			bot.sendMessage(CHAT_ID, "Stopping notifications");
		} else if (match[1] === "start") {
			areNotificationsAllowed = true;
			bot.sendMessage(CHAT_ID, "Starting notifications");
		} else if (match[1] === "status") {
			bot.sendMessage(CHAT_ID, "Running");
		}
	});
}

function getWorkbook() {
	try {
		workbook = XLSX.readFile(POLL_RESULTS_FILE_NAME);
	} catch (err) {
		workbook = XLSX.utils.book_new();
	}
}

function startPolling() {
	initializeTelegramBot();
	getWorkbook();
	pollTrainsForWeek();
	pollMyTrains();
}

function pollTrainsForWeek() {
	let pollInterval = null; 
	const pollForWeek = () => {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
		let tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		pollInterval = pollTrains({
			fromStationId: OdessaStationId,
			toStationId: LvivStationId,
			startDate: tomorrow,
			daySpan: 7,
			bothWays: true,
			interval: HOUR_IN_MILISECONDS
		});
	}
	pollForWeek();
	setInterval(pollForWeek, HOUR_IN_MILISECONDS * 24);
}

function pollMyTrains() {
	pollTrains({
		fromStationId: OdessaStationId,
		toStationId: LvivStationId,
		startDate: new Date('2019-01-03'),
		interval: 5 * 60 * 1000,
		priority: true
	});
	pollTrains({
		fromStationId: LvivStationId,
		toStationId: OdessaStationId,
		startDate: new Date('2019-01-09'),
		interval: 5 * 60 * 1000,
		priority: true
	});
}

function pollTrains({fromStationId, toStationId, startDate = new Date(), interval = -1, bothWays = false, daySpan = 1, priority = false} = options) {
	const wsName = `${addLeadingZero(startDate.getDate())}.${addLeadingZero(startDate.getMonth() + 1)} ${fromStationId}-${toStationId}`;
	const pollTrainsForDate = () => {
		const formParamsArray = [];
		for (var i = 0; i < daySpan; i++) {
			let trainDate = new Date(startDate);
			trainDate.setDate(startDate.getDate() + i);
			formParamsArray.push([fromStationId, toStationId, trainDate]);
			if (bothWays) {
				formParamsArray.push([toStationId, fromStationId, trainDate]);
			}
		}
		Promise.all(formParamsArray.map(formParams => fetch(trainSearchUrl, {method: 'POST', body: makeForm(...formParams)}).then(res => res.json())))
			.then(data => parseAndSaveTrainsData(data, wsName, priority));
	}
	pollTrainsForDate();
	if (interval !== -1) {
		return setInterval(pollTrainsForDate, interval);
	}
}

function getFormattedDate(date) {
	return date.getFullYear() + '-' + addLeadingZero(date.getMonth() + 1) + '-' + addLeadingZero(date.getDate());
}

function getFormattedTime(date) {
	return addLeadingZero(date.getHours()) + ':' + addLeadingZero(date.getMinutes()) + ':' + addLeadingZero(date.getSeconds());
}

function addLeadingZero(datePart) {
	return ('0' + datePart).slice(-2);
}

function makeForm(fromStationId, toStationId, date) {
	const params = new URLSearchParams();
	params.append('from', fromStationId);
	params.append('to', toStationId);
	params.append('time', '00:00');
	params.append('date', getFormattedDate(date));
	return params;
}

function parseAndSaveTrainsData(trainsData, wsName, priority) {
	let today = new Date();
	const finalResult = {
		'Time': getFormattedTime(today)
	};
	let ws;

	trainsData = trainsData.filter(route => !route.error); // remove routes without seats or for wrong dates

	trainsData = trainsData.reduce((result, route) => {
		result.push(...route.data.list);
		return result;
	}, []);

	//moyo govno
	trainsData = trainsData.filter(train => {
		const targetDate = new Date(), trainDate = new Date();
		const trainTime = train.to.code === LvivStationId ? train.to.time : train.from.time;
		targetDate.setHours(6, 0, 0, 0);
		trainDate.setHours(...trainTime.split(':'), 0, 0);
		return trainDate < targetDate;
	})

	trainsData = _.groupBy(trainsData, train => `${train.from.station[0]} - ${train.to.station[0]} ${train.from.srcDate.slice(5).split('-').reverse().join('.')}`);

	Object.keys(trainsData).forEach(title => {
		let seats = trainsData[title].reduce((result, train) => {
			const trainSeats = train.types.reduce((acc, val) => acc + val.places, 0);
			if (priority === true && trainSeats > 0 && areNotificationsAllowed === true) {
				const notificationName = '' + train.num + train.from.code + train.to.code;
				sendNotification(train, trainSeats);
			}
			return result + trainSeats;
		}, 0);

		finalResult[title] = seats || 'нема';
	})

	const header = ['Time'].concat(Object.keys(trainsData));
	if (workbook.SheetNames.indexOf(wsName) === -1) {
		ws = XLSX.utils.json_to_sheet([finalResult], {header});
		ws['!cols'] = header.map(() => ({width: 12}));
		XLSX.utils.book_append_sheet(workbook, ws, wsName);
	} else {
		ws = workbook.Sheets[wsName];
		XLSX.utils.sheet_add_json(ws, [finalResult], {
			header,
			skipHeader: true,
			origin: -1
		})
		workbook.Sheets[wsName] = ws;
	}

	try {
		XLSX.writeFile(workbook, POLL_RESULTS_FILE_NAME);
	} catch (err) {
		console.log(err);
	}
	console.log('Polled data');
}

function sendNotification(train, seats) {
	bot.sendMessage(CHAT_ID, `${seats} seats at ${train.num} train ${train.from.stationTrain} - ${train.to.stationTrain} ${train.from.srcDate} ${train.from.time} - ${train.to.time}`);
}

startPolling();