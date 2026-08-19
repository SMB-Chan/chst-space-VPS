import { Router, type IRouter } from "express";
import openaiRouter from "./openai";

const router: IRouter = Router();

router.use(openaiRouter);

export default router;
