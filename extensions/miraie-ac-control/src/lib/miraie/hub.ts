import axios from "axios";
import { addDays, endOfWeek, format, startOfWeek } from "date-fns";
import { MirAIeBroker } from "./broker";
import { User } from "./user";
import { MirAIeTopic } from "./topic";
import { Home } from "./home";
import { Device, DeviceDetails, DeviceStatus, PowerConsumptionDetails } from "./device";
import { isValidEmail, toFloat } from "./utils";
import {
  PowerMode,
  FanMode,
  SwingMode,
  DisplayMode,
  HVACMode,
  PresetMode,
  ConvertiMode,
  ConsumptionPeriodType,
} from "./enums";
import * as constants from "./constants";

type LoginResponse = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  userId: string;
};

type DeviceDetailsResponse = {
  deviceId: string;
  modelName: string;
  macAddress: string;
  category: string;
  brand: string;
  firmwareVersion: string;
  serialNumber: string;
  modelNumber: string;
  productSerialNumber: string;
};

type HomeSpaceResponse = {
  spaceName: string;
  spaceId: string;
  spaceType: string;
  members: string[];
  devices: {
    deviceId: string;
    deviceName: string;
    topic: string[];
  }[];
};

type HomeResponse = {
  homeId: string;
  spaces: HomeSpaceResponse[];
};

type DeviceStatusResponse = {
  deviceId?: string;
  ty?: string;
  onlineStatus?: string;
  actmp?: string | number | null;
  rmtmp?: string | number | null;
  ps?: PowerMode;
  acfs?: FanMode;
  acvs?: SwingMode;
  achs?: SwingMode;
  acdc?: DisplayMode;
  acmd?: HVACMode;
  acpm?: string;
  acem?: string;
  acec?: string;
  cnv?: number;
  connectedTime?: number;
  actm?: number[];
};

type EnergyConsumptionEntry = {
  power?: number;
};

export class MirAIeHub {
  private topicsMap: Map<string, MirAIeTopic> = new Map();
  private backgroundTasks: Set<Promise<void>> = new Set();
  private _broker!: MirAIeBroker;
  user!: User;
  home!: Home;
  username!: string;
  password!: string;

  get broker(): MirAIeBroker {
    return this._broker;
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.user.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async init(username: string, password: string, broker: MirAIeBroker): Promise<void> {
    this._broker = broker;

    await this.authenticate(username, password);
    await this.getHomeDetails();
    await this.getAllDeviceStatus(true);
    await this.initBroker(broker);
  }

  private async initBroker(broker: MirAIeBroker): Promise<void> {
    const topics = this.getDeviceTopics();
    broker.setTopics(topics);

    if (!broker.isConnected()) {
      const task = broker.connect(this.home.id, this.user.accessToken, this.getToken.bind(this));
      this.backgroundTasks.add(task);
    }
  }

  getDeviceTopics(): string[] {
    const deviceTopics = this.home.devices.flatMap((device) => [device.statusTopic, device.connectionStatusTopic]);
    return deviceTopics;
  }

  async getToken(): Promise<string> {
    try {
      await this.authenticate(this.username, this.password);
      return this.user.accessToken;
    } catch {
      return this.user.accessToken;
    }
  }

  private async authenticate(username: string, password: string): Promise<boolean> {
    const isEmail = isValidEmail(username);

    const data: Record<string, unknown> = {
      clientId: constants.MIRAIE_APP_CLIENT_ID,
      password: password,
      scope: constants.MIRAIE_APP_SCOPE,
    };

    if (isEmail) {
      data.email = username;
    } else {
      data.mobile = username;
    }

    const response = await fetch(constants.LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (response.status === 200) {
      const json = (await response.json()) as LoginResponse;
      this.user = new User(json.accessToken, json.expiresIn, json.refreshToken, json.userId);
      this.username = username;
      this.password = password;
      return true;
    }

    throw new Error("Authentication failed");
  }

  private async getDeviceDetails(deviceIds: string): Promise<DeviceDetailsResponse[]> {
    const response = await fetch(constants.DEVICE_DETAILS_URL + "/" + deviceIds, {
      headers: this.buildHeaders(),
    });

    try {
      return (await response.json()) as DeviceDetailsResponse[];
    } catch {
      throw new Error("Unable to fetch device details");
    }
  }

  private async processHomeDetails(jsonData: HomeResponse): Promise<Home> {
    const existingDevices = new Map(this.home?.devices.map((device) => [device.id, device]) ?? []);
    const devices: Device[] = [];

    for (const space of jsonData.spaces) {
      for (const device of space.devices) {
        const name = String(device.deviceName).toLowerCase().replace(/ /g, "-");
        const controlTopic = String(device.topic[0]) + "/control";
        const statusTopic = String(device.topic[0]) + "/status";
        const connectionStatusTopic = String(device.topic[0]) + "/connectionStatus";

        const item =
          existingDevices.get(device.deviceId) ??
          new Device(
            device.deviceId,
            name,
            device.deviceName,
            space,
            controlTopic,
            statusTopic,
            connectionStatusTopic,
            this._broker,
          );

        item.updateDefinition(name, device.deviceName, space, controlTopic, statusTopic, connectionStatusTopic);
        devices.push(item);
        const topic = new MirAIeTopic(item.controlTopic, item.statusTopic, item.connectionStatusTopic);
        this.topicsMap.set(item.id, topic);
      }
    }

    for (const existingDevice of existingDevices.values()) {
      if (!devices.some((device) => device.id === existingDevice.id)) {
        existingDevice.destroy();
      }
    }

    const deviceIds = devices.map((device) => device.id).join(",");
    const deviceDetails = await this.getDeviceDetails(deviceIds);

    for (const dd of deviceDetails) {
      const device = devices.find((d) => d.id === dd.deviceId);
      if (!device) continue;

      const details = new DeviceDetails(
        dd.modelName,
        dd.macAddress,
        dd.category,
        dd.brand,
        dd.firmwareVersion,
        dd.serialNumber,
        dd.modelNumber,
        dd.productSerialNumber,
      );

      device.setDetails(details);
    }

    this.home = new Home(jsonData.homeId, devices);
    return this.home;
  }

  private async getHomeDetails(): Promise<void> {
    const response = await fetch(constants.HOMES_URL, {
      headers: this.buildHeaders(),
    });
    const resp = (await response.json()) as HomeResponse[];
    await this.processHomeDetails(resp[0]);
  }

  private async getDeviceStatus(deviceId: string): Promise<DeviceStatusResponse> {
    const response = await fetch(constants.STATUS_URL.replace("{deviceId}", deviceId), {
      headers: this.buildHeaders(),
    });
    const resp = (await response.json()) as DeviceStatusResponse;
    resp.deviceId = deviceId;
    return resp;
  }

  async getAllDeviceStatus(fetchEnergy = false): Promise<DeviceStatusResponse[]> {
    const statuses = await Promise.all(this.home.devices.map((device) => this.getDeviceStatus(device.id)));

    if (fetchEnergy) {
      await this.getAllPowerConsumptionDetails();
    }

    for (const status of statuses) {
      const device = this.home.devices.find((d) => d.id === status.deviceId);
      if (!device) continue;

      let statusObj: DeviceStatus;
      if (!status.ty || status.ty !== "AC") {
        statusObj = new DeviceStatus(
          false,
          24.0,
          24.0,
          PowerMode.OFF,
          FanMode.AUTO,
          SwingMode.AUTO,
          SwingMode.AUTO,
          DisplayMode.ON,
          HVACMode.AUTO,
          PresetMode.NONE,
          ConvertiMode.OFF,
          0,
          -1,
          -1,
        );
      } else {
        statusObj = new DeviceStatus(
          status.onlineStatus === "true",
          toFloat(status.actmp),
          toFloat(status.rmtmp),
          status.ps as PowerMode,
          status.acfs as FanMode,
          status.acvs as SwingMode,
          status.achs as SwingMode,
          status.acdc as DisplayMode,
          status.acmd as HVACMode,
          status.acpm === "on"
            ? PresetMode.BOOST
            : status.acem === "on"
              ? PresetMode.ECO
              : status.acec === "on"
                ? PresetMode.CLEAN
                : PresetMode.NONE,
          (status.cnv || 0) as ConvertiMode,
          status.connectedTime ?? 0,
          status.actm?.[0] ?? -1,
          status.actm?.[1] ?? -1,
        );
      }

      device.setStatus(statusObj);
    }

    return statuses;
  }

  async getAllPowerConsumptionDetails(): Promise<void> {
    // get today's, this week's and this month's power consumption details

    // for daily and weekly, date form should be in DDMMYYYY
    // for monthly, date form should be in MMYYYY
    const now = new Date();
    const formattedToday = format(now, "ddMMyyyy");

    // for weekly, start and end date should be sundays of the respective week
    const startSunday = format(startOfWeek(now), "ddMMyyyy");
    const endSunday = format(addDays(endOfWeek(now), 1), "ddMMyyyy");

    const monthEnd = format(now, "MMyyyy");

    const consumptionPromises = this.home.devices.flatMap((device) => [
      this.getEnergyConsumption(device.id, ConsumptionPeriodType.DAILY, formattedToday),
      this.getEnergyConsumption(device.id, ConsumptionPeriodType.WEEKLY, startSunday, endSunday),
      this.getEnergyConsumption(device.id, ConsumptionPeriodType.MONTHLY, monthEnd),
    ]);

    const results = await Promise.all(consumptionPromises);

    this.home.devices.forEach((device, index) => {
      const resultOffset = index * 3;
      const dailyData = results[resultOffset];
      const weeklyData = results[resultOffset + 1];
      const monthlyData = results[resultOffset + 2];

      const dailyTotal = dailyData?.[0]?.power ?? -1;
      const weeklyTotal = weeklyData?.[0]?.power ?? -1;
      const monthlyTotal = monthlyData?.[0]?.power ?? -1;

      const powerConsumption = new PowerConsumptionDetails(dailyTotal, weeklyTotal, monthlyTotal);

      // Store the consumption data on thze device
      device.setPowerConsumptionDetails(powerConsumption);
    });
  }

  async getEnergyConsumption(
    deviceId: Device["id"],
    periodType: ConsumptionPeriodType,
    fromDate: string,
    toDate?: string,
  ): Promise<EnergyConsumptionEntry[] | undefined> {
    if (!toDate) {
      toDate = fromDate;
    }

    const url = constants.ENERGY_CONSUMPTION_URL.replace("{deviceId}", deviceId)
      .replace("{periodType}", periodType)
      .replace("{fromDate}", fromDate)
      .replace("{toDate}", toDate);

    try {
      const { data } = await axios(url, { headers: this.buildHeaders() });
      return data;
    } catch (err) {
      console.error("Failed to fetch MirAIe energy details", err);
    }
  }
}
